/**
 * fable-replace — RECON. Look before you declare an op.
 *
 * `grepPreview` takes a JS RegExp (so lookahead/lookbehind work, unlike plain
 * ripgrep) or a literal string, and prints every match with context.
 *
 * When you are hunting import specifiers, match the QUOTED SPECIFIER itself, not
 * the statement shape. A pattern anchored on `import … from` silently undercounts:
 * it misses multi-line import statements, `export … from`, dynamic `import("…")`
 * and type-only `import("…").Type` positions.
 *
 * `recon` answers "which files name it, how often, and which declares it" as one report
 * that prints nothing, for a caller that reads data (`--find --json`, `genesis_replace_find`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { escapeRegex, FableReplaceError, identifierPattern, stateless } from "./internal";
import { stringifyJson } from "./json";
import type {
    CountMatchesParams,
    FindFilesParams,
    GrepPreviewParams,
    LeftoversParams,
    ReconReport,
    ShadowedFilesParams,
} from "./types";

/**
 * Recon helper: print every match of `pattern` across files with `context`
 * lines around it. Use INSIDE a sweep script before committing to ops, or in a
 * quick `bun -e` — keeps the recon and the edit in one reviewable place.
 */
export const grepPreview = ({ files, pattern, context = 2 }: GrepPreviewParams): number => {
    const rx = typeof pattern === "string" ? new RegExp(escapeRegex(pattern)) : stateless(pattern);
    let total = 0;
    for (const file of files) {
        if (!fs.existsSync(file)) {
            console.log(`?? ${file} (missing)`);
            continue;
        }
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((l, idx) => {
            if (rx.test(l)) {
                total += 1;
                console.log(`\n${file}:${idx + 1}`);
                for (let j = Math.max(0, idx - context); j <= Math.min(lines.length - 1, idx + context); j += 1) {
                    console.log(`${j === idx ? ">" : " "} ${String(j + 1).padStart(4)}| ${lines[j]}`);
                }
            }
        });
    }
    console.log(`\n${total} match(es) across ${files.length} file(s)`);
    return total;
};

const CODE_EXT_RE = /\.(m|c)?(ts|js)x?$/;
// Tested against each directory NAME while descending, never against the root the
// caller passed in — a root under .worktrees/ must still be scannable.
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

const walk = (dir: string, out: string[]): void => {
    // A fable-replace backup dir holds pre-sweep copies, so it ALWAYS contains the old
    // name. Reporting it as a survivor is pure noise.
    if (fs.existsSync(`${dir}/fable-replace-manifest.json`)) {
        return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) {
                continue;
            }
            walk(full, out);
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
};

export interface LeftoverReport {
    /** Matches in code — usually legitimate aliases and re-exports, but check them. */
    code: string[];
    /** Matches in prose (markdown, text). A rename that skipped these left the docs lying. */
    docs: string[];
}

/**
 * After a rename, find every place the OLD name still appears. Three of five trial
 * sweeps shipped green code while leaving README/CLAUDE.md naming a symbol that no
 * longer existed, so this splits code hits (often legitimate aliases) from prose hits
 * (almost never legitimate).
 */
export const leftovers = ({ names: needles, dirs, quiet = false }: LeftoversParams): LeftoverReport => {
    const report: LeftoverReport = { code: [], docs: [] };
    const files: string[] = [];
    for (const entry of dirs) {
        if (!fs.existsSync(entry)) {
            continue;
        }
        // A plain file is a legitimate target — the docs' own example passes README.md,
        // and readdirSync on it used to throw ENOTDIR.
        if (fs.statSync(entry).isDirectory()) {
            walk(entry, files);
        } else {
            files.push(entry);
        }
    }
    for (const file of files) {
        let content: string;
        try {
            content = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }
        for (const needle of needles) {
            const rx = needleRegex(needle);
            if (!rx.test(content)) {
                continue;
            }
            const lines = content
                .split("\n")
                .flatMap((l, i) => (rx.test(l) ? [`${file}:${i + 1}: ${l.trim().slice(0, 100)}`] : []));
            const bucket = CODE_EXT_RE.test(file) ? report.code : report.docs;
            for (const hit of lines) {
                // one line matching two needles is ONE surviving line, not two
                if (!bucket.includes(hit)) {
                    bucket.push(hit);
                }
            }
        }
    }
    if (!quiet && report.docs.length > 0) {
        console.log(
            `\n! ${report.docs.length} PROSE mention(s) of ${needles.join(", ")} survive the sweep — the docs now name something that does not exist:`
        );
        for (const hit of report.docs.slice(0, 20)) {
            console.log(`  ${hit}`);
        }
    }
    if (!quiet && report.docs.length === 0 && report.code.length === 0) {
        console.log(`leftovers: 0 hit(s) for ${needles.join(", ")} — nothing survives.`);
    }
    if (!quiet && report.code.length > 0) {
        console.log(
            `\n${report.code.length} code mention(s) remain (aliases and re-exports are legitimate — confirm each):`
        );
        for (const hit of report.code.slice(0, 10)) {
            console.log(`  ${hit}`);
        }
    }
    return report;
};

/** JSON input for the read-only find door. */
export const reconParamsFromJson = (
    value: unknown
): { pattern: string | RegExp; roots?: string[]; exts?: string[] } => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new FableReplaceError("find JSON must be an object", 2);
    }
    const fields = new Map(Object.entries(value));
    for (const key of fields.keys()) {
        if (!["pattern", "regex", "flags", "roots", "exts"].includes(key)) {
            throw new FableReplaceError(`find JSON: unknown key ${key}`, 2);
        }
    }
    const pattern = fields.get("pattern");
    if (typeof pattern !== "string" || !pattern.length) {
        throw new FableReplaceError("find JSON: pattern must be a non-empty string", 2);
    }
    const regex = fields.get("regex");
    const flags = fields.get("flags");
    if (regex !== undefined && typeof regex !== "boolean") {
        throw new FableReplaceError("find JSON: regex must be boolean", 2);
    }
    if (flags !== undefined && (regex !== true || typeof flags !== "string")) {
        throw new FableReplaceError("find JSON: flags requires regex true and a string", 2);
    }
    const list = (key: string): string[] | undefined => {
        const item = fields.get(key);
        if (item === undefined) {
            return undefined;
        }
        if (!Array.isArray(item) || item.some((entry) => typeof entry !== "string" || !entry.length)) {
            throw new FableReplaceError(`find JSON: ${key} must be an array of non-empty strings`, 2);
        }
        return item;
    };
    return {
        pattern: regex ? new RegExp(pattern, typeof flags === "string" ? flags : "") : pattern,
        roots: list("roots"),
        exts: list("exts"),
    };
};

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Word-boundary anchoring is right for an identifier and WRONG for anything else.
 * `\b@genesiscz/utils/Stopwatch\b` matches nothing at all, because the characters
 * either side of the needle are already non-word — so a leftover import path silently
 * reported zero hits, which is the worst possible failure in a safety check.
 */
const needleRegex = (needle: string, flags = ""): RegExp =>
    new RegExp(IDENTIFIER_RE.test(needle) ? identifierPattern(needle) : escapeRegex(needle), flags);

/**
 * Occurrences per file, ready to paste into `expect:` / `count:`. Two independent
 * trial runs hand-rolled `grep -o … | wc -l` loops for exactly this, then transcribed
 * the numbers by hand — which is a silent-error step in the one place the whole
 * verification contract rests on.
 *
 * A string pattern that looks like an identifier is matched on word boundaries (what
 * you want for a symbol rename); any other string is matched literally. A RegExp is
 * used as given, with the `g` flag forced on.
 */
export const countMatches = ({ files, pattern, quiet = false }: CountMatchesParams): Record<string, number> => {
    const rx =
        typeof pattern === "string"
            ? needleRegex(pattern, "g")
            : new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    const counts: Record<string, number> = {};
    for (const file of files) {
        if (!fs.existsSync(file)) {
            console.log(`?? ${file} (missing)`);
            continue;
        }
        counts[file] = (fs.readFileSync(file, "utf8").match(rx) ?? []).length;
    }
    // A file that DECLARES the same bare name matters, but not always the same way:
    //  - it declares AND imports the name  -> a local wrapper shadowing the shared one.
    //    Renaming its declaration changes an unrelated helper. Keep it out of the bucket.
    //  - it declares and does NOT import it -> the definition you are probably renaming,
    //    or an independent implementation. Only you can tell which.
    // Reporting both as "unrelated" cried wolf on the source module itself.
    const split =
        typeof pattern === "string" && IDENTIFIER_RE.test(pattern)
            ? shadowedFiles({ files: Object.keys(counts), name: pattern })
            : { shadows: [], declarers: [] };
    const { shadows, declarers } = split;
    if (!quiet) {
        const entries = Object.entries(counts);
        const total = entries.reduce((sum, [, n]) => sum + n, 0);
        const zero = entries.filter(([, n]) => n === 0);
        console.log(`\ncountMatches ${String(rx)} — ${total} occurrence(s) in ${entries.length} file(s):`);
        console.log(`const EXPECT: Record<string, number> = {`);
        for (const [file, n] of entries) {
            console.log(`\t${stringifyJson(file)}: ${n},`);
        }
        console.log(`};`);
        if (shadows.length > 0) {
            console.log(
                `! ${shadows.length} file(s) both IMPORT and DECLARE "${String(pattern)}" — a local wrapper. Renaming its declaration changes an unrelated helper:`
            );
            for (const file of shadows) {
                console.log(`  ${file}`);
            }
        }
        if (declarers.length > 0) {
            console.log(
                `· ${declarers.length} file(s) DECLARE "${String(pattern)}" without importing it — the definition you are renaming, or an independent implementation. Decide per file:`
            );
            for (const file of declarers) {
                console.log(`  ${file}`);
            }
        }
        if (zero.length > 0) {
            console.log(
                `! ${zero.length} file(s) contain ZERO matches — a non-optional op on those is a guaranteed MISS:`
            );
            for (const [file] of zero) {
                console.log(`  ${file}`);
            }
        }
    }
    return counts;
};

/**
 * Split `files` by how they relate to the identifier `name`: `shadows` both import AND
 * declare it (a local wrapper: renaming its declaration changes an unrelated helper),
 * `declarers` declare it without importing it (the definition, or an independent one).
 * countMatches prints this; renameSymbolAcross refuses the shadows unless told otherwise.
 */
export const shadowedFiles = ({ files, name }: ShadowedFilesParams): { shadows: string[]; declarers: string[] } => {
    const shadows: string[] = [];
    const declarers: string[] = [];
    const declRe = new RegExp(`\\b(?:function|class|const|let|var|interface|type)\\s+${identifierPattern(name)}`);
    const importRe = new RegExp(`import[^;]*${identifierPattern(name)}[^;]*from`, "s");
    for (const file of files) {
        let src: string;
        try {
            src = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }
        if (!declRe.test(src)) {
            continue;
        }
        (importRe.test(src) ? shadows : declarers).push(file);
    }
    return { shadows, declarers };
};

/**
 * Every file under `roots` whose CONTENT matches — the recon step that has to happen
 * BEFORE countMatches/grepPreview, which both take an already-known file list.
 *
 * Without this you cannot start inside the documented API: you shell out to ripgrep
 * for the file list first, which is exactly what the docs tell you not to do. Skips
 * node_modules, build output, and fable-replace backup dirs.
 */
export const findFiles = ({ roots, containing, exts = [".ts", ".tsx"] }: FindFilesParams): string[] => {
    // Without this, a forgotten `containing` returns [] — which reads as "no file holds
    // the symbol" and quietly turns the whole sweep into a no-op.
    if (containing === undefined || containing === "") {
        throw new FableReplaceError(
            'findFiles: "containing" is required (a literal string or a RegExp); it is the content filter, not an option',
            2
        );
    }

    const rx = typeof containing === "string" ? new RegExp(escapeRegex(containing)) : stateless(containing);
    const all: string[] = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) {
            continue;
        }
        // A plain file is a legitimate root too (README.md, CLAUDE.md): readdirSync on
        // it used to throw a bare ENOTDIR.
        if (fs.statSync(root).isFile()) {
            all.push(root);
        } else {
            walk(root, all);
        }
    }
    return all
        .filter((file) => exts.length === 0 || exts.some((ext) => file.endsWith(ext)))
        .filter((file) => {
            try {
                return rx.test(fs.readFileSync(file, "utf8"));
            } catch {
                return false;
            }
        })
        .sort();
};

/**
 * Every file under `roots` that names `pattern`, as one report a caller reads as data (`--find --json`, the MCP
 * tool `genesis_replace_find`). It prints nothing. It composes findFiles, countMatches and shadowedFiles, so a count
 * is countMatches' own: an identifier-shaped string matches on identifier boundaries, any other string literally, a
 * RegExp as given. A file with no match is left out. `declares` is true on a file that declares the identifier (the
 * definition or a local wrapper), and false on every row of any other pattern.
 *
 * Roots resolve against `cwd` (default: the process folder). A file inside `cwd` is reported relative to it, so its
 * row goes straight into a FileEdit of a run with the same `cwd`; a file outside it stays absolute. No root, or a
 * root that does not exist, is refused (code 2), so a typo never reads as "nothing names it".
 */
export const recon = ({
    roots,
    pattern,
    exts,
    cwd,
}: {
    roots: string[];
    pattern: string | RegExp;
    exts?: string[];
    cwd?: string;
}): ReconReport => {
    const base = path.resolve(cwd ?? ".");
    if (roots.length === 0) {
        throw new FableReplaceError("recon: no root to search; pass at least one folder or file in roots", 2);
    }

    const resolved = roots.map((root) => path.resolve(base, root));
    const missing = roots.filter((_root, i) => !fs.existsSync(resolved[i]));
    if (missing.length > 0) {
        throw new FableReplaceError(`recon: root(s) not found under ${base}: ${missing.join(", ")}`, 2);
    }

    const counts = countMatches({
        files: findFiles({ roots: resolved, containing: pattern, exts }),
        pattern,
        quiet: true,
    });
    const hits = Object.keys(counts).filter((file) => counts[file] > 0);
    const declaring = new Set<string>();
    if (typeof pattern === "string" && IDENTIFIER_RE.test(pattern)) {
        const { shadows, declarers } = shadowedFiles({ files: hits, name: pattern });
        for (const file of [...shadows, ...declarers]) {
            declaring.add(file);
        }
    }

    const shown = (file: string): string => {
        const rel = path.relative(base, file);
        return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? file : rel;
    };
    const files = hits.map((file) => ({ file: shown(file), count: counts[file], declares: declaring.has(file) }));
    return {
        v: 1,
        pattern: typeof pattern === "string" ? pattern : String(pattern),
        roots: [...roots],
        total: files.reduce((sum, row) => sum + row.count, 0),
        files,
    };
};
