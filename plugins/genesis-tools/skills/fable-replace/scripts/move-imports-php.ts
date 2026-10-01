/**
 * fable-replace — `imports=fix` for PHP. PHP names a class through its `namespace` and `use`
 * statements, and composer's PSR-4 map ties a namespace to a folder, so a move works like this:
 *
 * - The target gets the `use` lines its new code relies on: copied from the source, plus one for
 *   each same-namespace class the code named bare, when the target's namespace differs.
 * - The source drops each `use` entry only the moved code used, and gains `use` lines for the
 *   moved classes it still names.
 * - When a moved class changes namespace, every importer follows: `use` lines are re-pointed (a
 *   group `use A\{B, C}` is split), same-namespace users gain a `use` line, `\Old\Ns\Class` in code
 *   is rewritten, and a class name inside a string (a config file) is a warning with its op.
 *
 * A new target file starts with `<?php`, the source's `declare(strict_types=1)` and the namespace
 * PSR-4 gives its folder. Every refusal and warning carries the spec change that clears it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
    listProjectFiles,
    literalOpSpec,
    type PlanImportFixesParams,
    type PlannedMove,
    parseJsonc,
    toPosix,
    warnWithFix,
} from "./move-imports-shared";
import type { FileEdit, Op } from "./types";

/** `text` with comments, string bodies and heredocs blanked; offsets are kept. */
export const maskPhp = (text: string): string => {
    const chars = text.split("");
    const blank = (from: number, to: number): void => {
        for (let k = from; k < to && k < chars.length; k++) {
            if (chars[k] !== "\n") {
                chars[k] = " ";
            }
        }
    };
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (text.startsWith("//", i) || (c === "#" && text[i + 1] !== "[")) {
            const newline = text.indexOf("\n", i);
            const end = newline === -1 ? text.length : newline;
            blank(i, end);
            i = end;
            continue;
        }

        if (text.startsWith("/*", i)) {
            const close = text.indexOf("*/", i + 2);
            const end = close === -1 ? text.length : close + 2;
            blank(i, end);
            i = end;
            continue;
        }

        const heredoc = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(text.slice(i, i + 80));
        if (heredoc !== null) {
            const bodyStart = i + heredoc[0].length;
            const closer = new RegExp(`^[ \\t]*${heredoc[2]}\\b`, "m");
            const found = closer.exec(text.slice(bodyStart));
            const end = found === null ? text.length : bodyStart + (found.index ?? 0);
            blank(bodyStart, end);
            i = end;
            continue;
        }

        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < text.length && text[j] !== c) {
                j += text[j] === "\\" ? 2 : 1;
            }

            blank(i + 1, j);
            i = j + 1;
            continue;
        }

        i++;
    }

    return chars.join("");
};

export interface UseEntry {
    kind: "class" | "function" | "const";
    fqn: string;
    alias: string;
}

export interface UseStatement {
    text: string;
    kind: "class" | "function" | "const";
    /** `A\B` of a group `use A\B\{C, D}`; undefined for a plain list. */
    group?: string;
    entries: UseEntry[];
}

const TEXT_FILE = /\.(?:neon|ya?ml|json|xml|md|txt|ini|env|dist|stub|twig|blade)$|\.neon\.dist$|\.xml\.dist$/;

const lastSegment = (fqn: string): string => fqn.slice(fqn.lastIndexOf("\\") + 1);
const namespaceOf = (fqn: string): string => (fqn.includes("\\") ? fqn.slice(0, fqn.lastIndexOf("\\")) : "");
const same = (a: string, b: string): boolean =>
    a.replace(/^\\/, "").toLowerCase() === b.replace(/^\\/, "").toLowerCase();

const parseEntry = (raw: string, kind: UseEntry["kind"], prefix = ""): UseEntry | null => {
    const match = /^(function\s+|const\s+)?\\?([\w\\]+)(?:\s+as\s+(\w+))?$/.exec(raw.trim());
    if (match === null) {
        return null;
    }

    const own = match[1]?.trim() as UseEntry["kind"] | undefined;
    const fqn = prefix === "" ? match[2] : `${prefix}\\${match[2]}`;
    return { kind: own ?? kind, fqn, alias: match[3] ?? lastSegment(fqn) };
};

/** The file's top-level `use` statements (column 0); a trait `use` inside a class is indented. */
export const parseUses = (text: string, masked: string = maskPhp(text)): UseStatement[] => {
    const out: UseStatement[] = [];
    for (const match of masked.matchAll(/^use\s+(function\s+|const\s+)?([^;]+);/gm)) {
        const start = match.index ?? 0;
        const statementText = text.slice(start, start + match[0].length);
        const kind = (match[1]?.trim() ?? "class") as UseStatement["kind"];
        const body = text.slice(
            start + match[0].indexOf(match[2]),
            start + match[0].indexOf(match[2]) + match[2].length
        );
        const group = /^\\?([\w\\]+)\\\{([^}]*)\}\s*$/.exec(body.trim());
        const entries = (group === null ? body.split(",") : group[2].split(","))
            .map((raw) => parseEntry(raw, kind, group?.[1] ?? ""))
            .filter((entry): entry is UseEntry => entry !== null);
        out.push({ text: statementText, kind, ...(group === null ? {} : { group: group[1] }), entries });
    }

    return out;
};

const renderUse = (statement: { kind: UseStatement["kind"]; group?: string }, entries: UseEntry[]): string => {
    const keyword = statement.kind === "class" ? "use" : `use ${statement.kind}`;
    const name = (entry: UseEntry, prefix: string): string => {
        const short = prefix === "" ? entry.fqn : entry.fqn.slice(prefix.length + 1);
        return entry.alias === lastSegment(entry.fqn) ? short : `${short} as ${entry.alias}`;
    };
    if (statement.group !== undefined && entries.length > 1) {
        return `${keyword} ${statement.group}\\{${entries.map((entry) => name(entry, statement.group ?? "")).join(", ")}};`;
    }

    return entries.map((entry) => `${keyword} ${name(entry, "")};`).join("\n");
};

export const fileNamespace = (masked: string): string | null =>
    masked.match(/^namespace\s+([\w\\]+)\s*;/m)?.[1] ?? null;

export interface PhpDeclaration {
    kind: string;
    name: string;
}

export const phpDeclarations = (masked: string): PhpDeclaration[] => [
    ...[...masked.matchAll(/^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/gm)].map((m) => ({
        kind: m[1],
        name: m[2],
    })),
    ...[...masked.matchAll(/^function\s+&?\s*(\w+)/gm)].map((m) => ({ kind: "function", name: m[1] })),
];

const KEYWORDS = new Set([
    "self",
    "static",
    "parent",
    "true",
    "false",
    "null",
    "array",
    "callable",
    "iterable",
    "object",
    "mixed",
    "void",
    "never",
]);

/**
 * Names the code refers to as classes: `new X`, `X::`, type hints, `extends`, `instanceof`, a trait
 * `use X;` inside a class, attributes `#[X(...)]`, and, when `raw` is given, the types in docblock
 * tags (`@var array<int, X>`), which static analysis resolves through the same `use` lines.
 */
export const classReferences = (masked: string, raw?: string): Set<string> => {
    const out = new Set<string>();
    for (const match of masked.matchAll(/(?<![\w$\\>:])(\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*)/g)) {
        const name = match[1];
        const index = match.index ?? 0;
        const at = index + name.length;
        const before = masked.slice(Math.max(0, index - 10), index);
        const first = name.replace(/^\\/, "").split("\\")[0];
        if (KEYWORDS.has(first.toLowerCase()) || /\b(?:function|const|namespace|fn)\s+$/.test(before)) {
            continue;
        }

        // A bare call is a function: PHP falls back to the global one, so it needs no `use`. An
        // attribute `#[X(...)]` looks like a call and is a class.
        const inAttribute = masked.lastIndexOf("#[", index) > masked.lastIndexOf("]", index);
        const callsIt = /^\s*\(/.test(masked.slice(at, at + 4)) && !/\bnew\s+$/.test(before) && !inAttribute;
        // An all-uppercase name stays: `PDO` and `URL` are classes. A constant (`PHP_EOL`) only
        // matters if a `use` alias spells it, which is the case where it should count.
        if (callsIt || !/^[A-Z]/.test(first)) {
            continue;
        }

        out.add(name);
    }

    for (const doc of (raw ?? "").matchAll(/\/\*\*[\s\S]*?\*\//g)) {
        for (const tag of doc[0].matchAll(/@[\w-]+[ \t]+([^\n]*)/g)) {
            for (const name of tag[1].matchAll(/\\?[A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*/g)) {
                if (/^\\?[A-Z]/.test(name[0])) {
                    out.add(name[0]);
                }
            }
        }
    }

    return out;
};

interface Psr4 {
    prefixes: Array<{ prefix: string; dir: string }>;
}

const psr4Cache = new Map<string, Psr4 | null>();

/** The nearest composer.json's PSR-4 map (autoload and autoload-dev), longest prefix first. */
const psr4For = (file: string): Psr4 | null => {
    let dir = path.dirname(file);
    while (true) {
        const cached = psr4Cache.get(dir);
        if (cached !== undefined) {
            return cached;
        }

        const composer = path.join(dir, "composer.json");
        if (fs.existsSync(composer)) {
            let result: Psr4 | null = null;
            try {
                const raw = parseJsonc(fs.readFileSync(composer, "utf8")) as Record<
                    string,
                    Record<string, unknown> | undefined
                >;
                const prefixes: Psr4["prefixes"] = [];
                for (const section of [raw.autoload, raw["autoload-dev"]]) {
                    const map = (section?.["psr-4"] ?? {}) as Record<string, string | string[]>;
                    for (const [prefix, dirs] of Object.entries(map)) {
                        for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
                            prefixes.push({ prefix: prefix.replace(/\\+$/, ""), dir: path.resolve(dir, d) });
                        }
                    }
                }

                result = { prefixes: prefixes.sort((a, b) => b.dir.length - a.dir.length) };
            } catch {
                result = null;
            }

            psr4Cache.set(dir, result);
            return result;
        }

        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }

        dir = parent;
    }
};

/** The namespace PSR-4 gives a file's folder, or null outside every PSR-4 root. */
export const psr4Namespace = (file: string): string | null => {
    const map = psr4For(file);
    const folder = path.dirname(file);
    for (const { prefix, dir } of map?.prefixes ?? []) {
        if (folder === dir || folder.startsWith(`${dir}${path.sep}`)) {
            const rest = path
                .relative(dir, folder)
                .split(path.sep)
                .filter((part) => part !== "");
            return [prefix, ...rest].filter((part) => part !== "").join("\\");
        }
    }

    return null;
};

/** The file PSR-4 expects for a class, or null when no prefix covers it. */
const psr4File = (fromFile: string, fqn: string): string | null => {
    // The most specific namespace wins (`App\Domain` before `App`), wherever their folders are.
    const prefixes = [...(psr4For(fromFile)?.prefixes ?? [])].sort((a, b) => b.prefix.length - a.prefix.length);
    for (const { prefix, dir } of prefixes) {
        if (prefix === "" || fqn.toLowerCase().startsWith(`${prefix.toLowerCase()}\\`)) {
            const rest = prefix === "" ? fqn : fqn.slice(prefix.length + 1);
            return path.join(dir, `${rest.split("\\").join(path.sep)}.php`);
        }
    }

    return null;
};

/** What a new PHP file starts with: the opening tag, strict types if the source has them, the namespace. */
export const phpPreamble = (targetAbs: string, sourceText: string): string => {
    const masked = maskPhp(sourceText);
    const strict = /^declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;/m.test(masked) ? "declare(strict_types=1);\n\n" : "";
    const namespace = psr4Namespace(targetAbs) ?? fileNamespace(masked);
    return `<?php\n\n${strict}${namespace === null ? "" : `namespace ${namespace};\n`}`;
};

interface PhpFilePlan {
    abs: string;
    text: string;
    masked: string;
    namespace: string | null;
    uses: UseStatement[];
    /** Statement index → its new entries (empty: the statement goes). */
    rewritten: Map<number, UseEntry[]>;
    added: UseEntry[];
    ops: Op[];
}

const compareUse = (a: UseEntry, b: UseEntry): number => {
    const x = `${a.kind}:${a.fqn}`.toLowerCase();
    const y = `${b.kind}:${b.fqn}`.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
};

const planUseOps = (plan: PhpFilePlan, label: string): Op[] => {
    const ops: Op[] = [];
    const before = new Map<number, string[]>();
    const after: string[] = [];
    const fresh = plan.added.filter(
        (entry, k) =>
            plan.added.findIndex(
                (other) => other.alias.toLowerCase() === entry.alias.toLowerCase() && other.kind === entry.kind
            ) === k
    );
    for (const entry of [...fresh].sort(compareUse)) {
        const line = renderUse({ kind: entry.kind }, [entry]);
        const at = plan.uses.findIndex(
            (statement) => statement.entries.length > 0 && compareUse(statement.entries[0], entry) > 0
        );
        if (at === -1) {
            after.push(line);
        } else {
            before.set(at, [...(before.get(at) ?? []), line]);
        }
    }

    for (const [index, statement] of plan.uses.entries()) {
        const entries = plan.rewritten.get(index);
        const extraBefore = before.get(index) ?? [];
        const extraAfter = index === plan.uses.length - 1 ? after : [];
        if (entries === undefined && extraBefore.length === 0 && extraAfter.length === 0) {
            continue;
        }

        const own =
            entries === undefined ? [statement.text] : entries.length === 0 ? [] : [renderUse(statement, entries)];
        const parts = [...extraBefore, ...own, ...extraAfter];
        const eats = parts.length === 0 && plan.text.includes(`${statement.text}\n`);
        ops.push({ find: eats ? `${statement.text}\n` : statement.text, replace: parts.join("\n"), label });
    }

    if (plan.uses.length === 0 && after.length > 0) {
        // No `use` yet: the block goes under the namespace line, or under the opening tag.
        const anchor =
            plan.text.match(/^namespace\s+[\w\\]+\s*;[^\n]*$/m)?.[0] ?? plan.text.match(/^<\?php[^\n]*$/m)?.[0];
        if (anchor !== undefined) {
            ops.push({ find: anchor, replace: `${anchor}\n\n${after.join("\n")}`, label });
        }
    }

    return ops;
};

export const planPhpImportFixes = (params: PlanImportFixesParams): FileEdit[] => {
    const { moves, cwd, read } = params;
    const fixing = moves.filter((move) => move.fixImports);
    if (fixing.length === 0) {
        return [];
    }

    const display = (abs: string): string => toPosix(path.relative(cwd, abs));
    const plans = new Map<string, PhpFilePlan>();
    const planFor = (abs: string): PhpFilePlan => {
        let plan = plans.get(abs);
        if (plan === undefined) {
            const text = read(abs) ?? "";
            const masked = maskPhp(text);
            plan = {
                abs,
                text,
                masked,
                namespace: fileNamespace(masked),
                uses: parseUses(text, masked),
                rewritten: new Map(),
                added: [],
                ops: [],
            };
            plans.set(abs, plan);
        }

        return plan;
    };
    const allFiles = params.projectFiles ?? listProjectFiles(cwd);
    const phpFiles = allFiles.filter((file) => file.endsWith(".php"));
    // Non-PHP text that can name a class: analyser baselines, YAML/JSON/XML config, docs.
    const textFiles = allFiles.filter((file) => TEXT_FILE.test(file));
    // A file's text once the whole batch is applied: its own text without the blocks cut from it,
    // plus every block pasted into it, whichever source and target the move names.
    const finalTexts = new Map<string, string>();
    const finalText = (abs: string): string => {
        let text = finalTexts.get(abs);
        if (text === undefined) {
            text = moves.reduce(
                (current, move) => (move.fromAbs === abs ? current.replace(move.cutText, "") : current),
                read(abs) ?? ""
            );
            text += moves
                .filter((move) => move.toAbs === abs)
                .map((move) => `\n${move.blockText}`)
                .join("");
            finalTexts.set(abs, text);
        }

        return text;
    };
    const touchedPhp = [...new Set([...phpFiles, ...moves.flatMap((move) => [move.fromAbs, move.toAbs])])].filter(
        (file) => file.endsWith(".php")
    );

    for (const sourceAbs of [...new Set(fixing.map((move) => move.fromAbs))]) {
        const source = planFor(sourceAbs);
        const sourceNs = source.namespace ?? "";
        let remaining = source.text;
        for (const move of moves.filter((m) => m.fromAbs === sourceAbs)) {
            remaining = remaining.replace(move.cutText, "");
        }

        const remainingMasked = maskPhp(remaining);
        const usesBlanked = (masked: string, uses: UseStatement[], text: string): string => {
            let out = masked;
            for (const statement of uses) {
                const at = text.indexOf(statement.text);
                if (at !== -1) {
                    out = out.slice(0, at) + " ".repeat(statement.text.length) + out.slice(at + statement.text.length);
                }
            }
            return out.replace(/^namespace\s+[\w\\]+\s*;/m, (line) => " ".repeat(line.length));
        };
        const originalRefs = classReferences(usesBlanked(source.masked, source.uses, source.text), source.text);
        const remainingRefs = classReferences(
            usesBlanked(remainingMasked, parseUses(remaining, remainingMasked), remaining),
            remaining
        );
        const remainingDecls = new Set(phpDeclarations(remainingMasked).map((d) => d.name.toLowerCase()));
        const aliasUsed = (refs: Set<string>, alias: string): boolean =>
            [...refs].some((ref) => ref.split("\\")[0].toLowerCase() === alias.toLowerCase());
        const callsIn = (masked: string, name: string): boolean =>
            new RegExp(`(?<![\\w$>:\\\\])${name}\\s*\\(`, "i").test(masked);

        // The source: entries only the moved code used go.
        for (const [index, statement] of source.uses.entries()) {
            const kept = statement.entries.filter((entry) =>
                entry.kind === "class"
                    ? !(aliasUsed(originalRefs, entry.alias) && !aliasUsed(remainingRefs, entry.alias))
                    : entry.kind === "function"
                      ? !(callsIn(source.masked, entry.alias) && !callsIn(remainingMasked, entry.alias))
                      : true
            );
            if (kept.length !== statement.entries.length) {
                source.rewritten.set(index, kept);
            }
        }

        for (const targetAbs of [...new Set(fixing.filter((m) => m.fromAbs === sourceAbs).map((m) => m.toAbs))]) {
            const toTarget = fixing.filter((m) => m.fromAbs === sourceAbs && m.toAbs === targetAbs);
            const target = planFor(targetAbs);
            const targetNs = target.text === "" ? (psr4Namespace(targetAbs) ?? sourceNs) : (target.namespace ?? "");
            const blocksMasked = maskPhp(toTarget.map((move) => move.blockText).join("\n"));
            const blockRefs = classReferences(blocksMasked, toTarget.map((move) => move.blockText).join("\n"));
            const moved: Array<PhpDeclaration & { move: PlannedMove }> = toTarget.flatMap((move) =>
                phpDeclarations(maskPhp(move.blockText)).map((d) => ({ ...d, move }))
            );
            const movedNames = new Set(moved.map((d) => d.name.toLowerCase()));
            const targetUses = new Set(target.uses.flatMap((s) => s.entries.map((e) => e.alias.toLowerCase())));
            const need = (entry: UseEntry): void => {
                if (
                    namespaceOf(entry.fqn).toLowerCase() === targetNs.toLowerCase() &&
                    entry.alias === lastSegment(entry.fqn)
                ) {
                    return;
                }

                if (!targetUses.has(entry.alias.toLowerCase())) {
                    target.added.push(entry);
                    targetUses.add(entry.alias.toLowerCase());
                }
            };

            for (const statement of source.uses) {
                for (const entry of statement.entries) {
                    const used =
                        entry.kind === "class"
                            ? aliasUsed(blockRefs, entry.alias)
                            : entry.kind === "function"
                              ? callsIn(blocksMasked, entry.alias)
                              : new RegExp(`(?<![\\w$])${entry.alias}(?!\\w)`).test(blocksMasked);
                    if (used) {
                        need(entry);
                    }
                }
            }

            const sourceAliases = new Set(source.uses.flatMap((s) => s.entries.map((e) => e.alias.toLowerCase())));
            if (!same(sourceNs, targetNs)) {
                // A bare name in the source meant its own namespace; in the target it needs a `use`.
                for (const ref of blockRefs) {
                    const first = ref.split("\\")[0];
                    if (
                        ref.startsWith("\\") ||
                        sourceAliases.has(first.toLowerCase()) ||
                        movedNames.has(first.toLowerCase())
                    ) {
                        continue;
                    }

                    const fqn = sourceNs === "" ? first : `${sourceNs}\\${first}`;
                    const known =
                        remainingDecls.has(first.toLowerCase()) || fs.existsSync(psr4File(sourceAbs, fqn) ?? "");
                    if (known) {
                        need({ kind: "class", fqn, alias: first });
                    }
                }
            }

            // PSR-4 loads `Ns\Class` from `Ns/Class.php`; a class in a file of another name never loads.
            const psr = psr4For(targetAbs);
            for (const declaration of moved.filter((d) => d.kind !== "function")) {
                if (psr !== null && path.basename(targetAbs, ".php") !== declaration.name) {
                    const better = toPosix(path.join(path.dirname(declaration.move.to), `${declaration.name}.php`));
                    warnWithFix(params, {
                        abs: targetAbs,
                        needles: [],
                        message: `imports=fix: ${declaration.kind} ${declaration.name} lands in ${declaration.move.to}, but PSR-4 autoloads it only from ${declaration.name}.php`,
                        fix: {
                            why: "move it into the file its name asks for:",
                            spec: declaration.move.marker.replace(`to=${declaration.move.to}`, `to=${better}`),
                        },
                    });
                }
            }

            if (same(sourceNs, targetNs)) {
                continue;
            }

            // The moved classes change namespace: the source and every importer follow.
            for (const declaration of moved) {
                const oldFqn = sourceNs === "" ? declaration.name : `${sourceNs}\\${declaration.name}`;
                const newFqn = targetNs === "" ? declaration.name : `${targetNs}\\${declaration.name}`;
                if (oldFqn.includes("\\")) {
                    for (const file of textFiles) {
                        let text: string;
                        try {
                            if (fs.statSync(file).size > 4_000_000) {
                                continue;
                            }

                            text = fs.readFileSync(file, "utf8");
                        } catch {
                            continue;
                        }

                        // One spelling per escaping level: `A\B`, `A\\B` (JSON, PHP strings), `A\\\\B` (regex in a string).
                        for (const level of [1, 2, 4]) {
                            const spelled = oldFqn.split("\\").join("\\".repeat(level));
                            // The name ends unless a word character or a deeper namespace (the same
                            // escape level of backslashes plus a letter) follows; `\:` in a regex is an escape.
                            const pattern = new RegExp(
                                `${spelled.replace(/\\/g, "\\\\")}(?!\\w|${"\\\\".repeat(level)}[A-Za-z_])`,
                                "g"
                            );
                            const count = [...text.matchAll(pattern)].length;
                            if (count === 0) {
                                continue;
                            }

                            warnWithFix(params, {
                                abs: file,
                                needles: [spelled],
                                message: `imports=fix: ${display(file)} names ${oldFqn} ${count} time(s), and the class moves to ${newFqn}`,
                                fix: {
                                    why: "rename it there too (an analyser baseline keyed on the old name stops matching otherwise):",
                                    spec: literalOpSpec(
                                        display(file),
                                        spelled,
                                        newFqn.split("\\").join("\\".repeat(level)),
                                        `count=${count}`
                                    ),
                                },
                            });
                        }
                    }
                }

                const entry: UseEntry = {
                    kind: declaration.kind === "function" ? "function" : "class",
                    fqn: newFqn,
                    alias: declaration.name,
                };
                const qualified = new RegExp(`(?<![\\w\\\\])\\\\${oldFqn.replace(/\\/g, "\\\\")}(?![\\w\\\\])`, "g");
                const qualifiedOp = (count: number): Op => ({
                    kind: "regex",
                    find: qualified,
                    replace: () => `\\${newFqn}`,
                    expect: count,
                    label: `imports=fix: \\${oldFqn} → \\${newFqn}`,
                });
                // `\Old\Ns\Class` written out (in code, or in a double-quoted string of one backslash),
                // counted on each file's final text: the code that stays, every moved block, every user.
                for (const file of touchedPhp) {
                    const written = [...finalText(file).matchAll(qualified)].length;
                    if (written > 0) {
                        planFor(file).ops.push(qualifiedOp(written));
                    }
                }

                const stillUsed =
                    entry.kind === "class"
                        ? aliasUsed(remainingRefs, declaration.name)
                        : callsIn(remainingMasked, declaration.name);
                if (stillUsed && !sourceAliases.has(declaration.name.toLowerCase())) {
                    source.added.push(entry);
                }

                for (const file of phpFiles) {
                    if (file === sourceAbs) {
                        continue;
                    }

                    const text = plans.get(file)?.text ?? read(file) ?? "";
                    if (!text.toLowerCase().includes(declaration.name.toLowerCase())) {
                        continue;
                    }

                    const plan = planFor(file);
                    let follows = false;
                    for (const [index, statement] of plan.uses.entries()) {
                        const current = plan.rewritten.get(index) ?? statement.entries;
                        const hit = current.findIndex((e) => same(e.fqn, oldFqn) && e.kind === entry.kind);
                        if (hit === -1) {
                            continue;
                        }

                        follows = true;
                        const repointed = { ...current[hit], fqn: newFqn };
                        if (file === targetAbs) {
                            plan.rewritten.set(
                                index,
                                current.filter((_, k) => k !== hit)
                            );
                        } else if (statement.group !== undefined && current.length > 1) {
                            plan.rewritten.set(
                                index,
                                current.filter((_, k) => k !== hit)
                            );
                            plan.added.push(repointed);
                        } else {
                            plan.rewritten.set(
                                index,
                                current.map((e, k) => (k === hit ? repointed : e))
                            );
                        }
                    }

                    const bareUser =
                        file !== targetAbs &&
                        !follows &&
                        same(plan.namespace ?? "", sourceNs) &&
                        !plan.uses.some((s) =>
                            s.entries.some((e) => e.alias.toLowerCase() === declaration.name.toLowerCase())
                        ) &&
                        (entry.kind === "class"
                            ? aliasUsed(classReferences(plan.masked, plan.text), declaration.name)
                            : callsIn(plan.masked, declaration.name));
                    if (bareUser) {
                        plan.added.push(entry);
                    }

                    // The name inside a string: configs, container bindings. A warning, with the op.
                    for (const spelling of [oldFqn, oldFqn.replace(/\\/g, "\\\\")]) {
                        for (const quote of ["'", '"']) {
                            const needle = `${quote}${spelling}${quote}`;
                            if (spelling.includes("\\") && text.includes(needle)) {
                                const replacement = `${quote}${spelling === oldFqn ? newFqn : newFqn.replace(/\\/g, "\\\\")}${quote}`;
                                warnWithFix(params, {
                                    abs: file,
                                    needles: [needle],
                                    message: `imports=fix: ${display(file)} names ${oldFqn} in a string, and the class moves to ${newFqn}`,
                                    fix: {
                                        why: "rewrite the string too:",
                                        spec: literalOpSpec(display(file), needle, replacement, "count=all"),
                                    },
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    const edits: FileEdit[] = [];
    for (const plan of plans.values()) {
        const ops = [...planUseOps(plan, "imports=fix"), ...plan.ops];
        if (ops.length > 0) {
            edits.push({ file: display(plan.abs), ops });
        }
    }

    return edits;
};
