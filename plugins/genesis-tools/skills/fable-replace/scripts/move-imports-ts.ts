/**
 * fable-replace — the IMPORTS of a move (`imports=fix`).
 *
 * A move relocates text, but the module graph around it is the expensive half of a file split:
 * the target needs the imports its new code uses, the source keeps imports nothing uses any more,
 * and every file that imported a moved export still points at the old module. This plans all three
 * as ordinary literal ops, so they ride in the same transaction as the cut and the paste.
 *
 * It is a lexical planner, not a type checker. A name counts as used when it appears as an
 * identifier outside comments, strings, property access and object keys. Every doubt resolves
 * toward KEEPING an import: a spare import fails a lint, a missing one fails the build.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { scanComments } from "./comments";
import { identifierPattern } from "./internal";
import {
    asNumber,
    asString,
    importLanguage,
    lineOf,
    listProjectFiles,
    MoveError,
    type PlanImportFixesParams,
    type PlannedMove,
    parseJsonc,
    toPosix,
    usesName,
} from "./move-imports-shared";
import type { FileEdit, Op } from "./types";

export interface NamedSpecifier {
    /** The entry as written: `type Foo`, `a as b`. */
    raw: string;
    imported: string;
    local: string;
}

export interface ImportStatement {
    start: number;
    end: number;
    text: string;
    keyword: "import" | "export";
    typeOnly: boolean;
    defaultName?: string;
    namespace?: string;
    /** Undefined when the statement has no braces. */
    named?: NamedSpecifier[];
    /** `export * from "x"`, without `as`. */
    star: boolean;
    specifier: string;
    quote: string;
    semicolon: boolean;
    multiline: boolean;
    indent: string;
    trailingComma: boolean;
}

/** `text` with every comment and literal body replaced by spaces; newlines and offsets are kept. */
export const maskNonCode = (text: string): string => {
    const literals: Array<{ start: number; end: number }> = [];
    const comments = scanComments(text, literals);
    const chars = text.split("");
    for (const span of [...comments, ...literals]) {
        for (let k = span.start; k < span.end && k < chars.length; k++) {
            if (chars[k] !== "\n") {
                chars[k] = " ";
            }
        }
    }

    return chars.join("");
};

const STATEMENT =
    /^(import|export)([ \t]+type)?[ \t]+((?:[\w$]+[ \t]*,[ \t]*)?(?:\{[^}]*\}|\*(?:[ \t]+as[ \t]+[\w$]+)?)|[\w$]+)\s*from[ \t]*(['"])([^'"\n]+)\4([ \t]*;)?/gm;

const parseNamed = (inner: string): NamedSpecifier[] =>
    inner
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((raw) => {
            const match = raw.match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
            return match === null
                ? { raw, imported: raw, local: raw }
                : { raw, imported: match[1], local: match[2] ?? match[1] };
        });

/** Every static `import … from` and `export … from` statement of `text`, in file order. */
export const parseImports = (text: string, masked: string = maskNonCode(text)): ImportStatement[] => {
    const statements: ImportStatement[] = [];
    for (const match of text.matchAll(STATEMENT)) {
        const start = match.index ?? 0;
        // A statement-shaped line inside a comment or a template is text, not an import.
        if (masked[start] !== text[start]) {
            continue;
        }

        const [whole, keyword, typeWord, clause, quote, specifier, semicolon] = match;
        const braceAt = clause.indexOf("{");
        const head = (braceAt === -1 ? clause : clause.slice(0, braceAt)).replace(/,\s*$/, "").trim();
        const inner = braceAt === -1 ? undefined : clause.slice(braceAt + 1, clause.lastIndexOf("}"));
        const namespace = head.match(/^\*\s+as\s+([\w$]+)$/)?.[1];
        const star = head === "*";
        const defaultName = namespace === undefined && !star && head.length > 0 ? head : undefined;
        const firstEntryLine = inner?.split("\n").find((line, k) => k > 0 && line.trim().length > 0);
        statements.push({
            start,
            end: start + whole.length,
            text: whole,
            keyword: keyword === "export" ? "export" : "import",
            typeOnly: typeWord !== undefined,
            ...(defaultName === undefined ? {} : { defaultName }),
            ...(namespace === undefined ? {} : { namespace }),
            ...(inner === undefined ? {} : { named: parseNamed(inner) }),
            star,
            specifier,
            quote,
            semicolon: semicolon !== undefined,
            multiline: inner?.includes("\n") ?? false,
            indent: firstEntryLine?.match(/^\s*/)?.[0] ?? "    ",
            trailingComma: inner?.trimEnd().endsWith(",") ?? false,
        });
    }

    return statements;
};

/** Text between and around the statements, with the statements themselves blanked. */
const blankStatements = (masked: string, statements: ImportStatement[]): string => {
    let out = masked;
    for (const statement of statements) {
        out = out.slice(0, statement.start) + " ".repeat(statement.end - statement.start) + out.slice(statement.end);
    }

    return out;
};

export interface Declarations {
    /** `typeOnly`: an interface or type alias, which an import must name with `type`. */
    names: Map<string, { exported: boolean; typeOnly: boolean }>;
    exportDefault: boolean;
}

const DECLARATION_LINE =
    /^(export[ \t]+)?(default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(const[ \t]+enum|function\*?|class|interface|type|enum|const|let|var|namespace)[ \t]+([\w$]+)/gm;
const LOCAL_EXPORT_LIST = /^export[ \t]+(?:type[ \t]+)?\{([^}]*)\}(?!\s*from\b)/gm;

/** Declarations that start at column 0 of `masked`: a split's unit is a top-level declaration. */
export const topLevelDeclarations = (masked: string): Declarations => {
    const names = new Map<string, { exported: boolean; typeOnly: boolean }>();
    for (const match of masked.matchAll(DECLARATION_LINE)) {
        const name = match[4];
        const exported = match[1] !== undefined || names.get(name)?.exported === true;
        // A function or namespace merging with an interface of the same name is a value too.
        const typeOnly = (match[3] === "interface" || match[3] === "type") && names.get(name)?.typeOnly !== false;
        names.set(name, { exported, typeOnly });
    }

    for (const match of masked.matchAll(LOCAL_EXPORT_LIST)) {
        for (const entry of parseNamed(match[1])) {
            const known = names.get(entry.imported);
            if (known !== undefined) {
                known.exported = true;
            }
        }
    }

    return { names, exportDefault: /^export[ \t]+default\b/m.test(masked) };
};

// ── module resolution ─────────────────────────────────────────────────────

/** How a specifier reached its file; `ext` is the extension it was written with, or "". */
type Via =
    | { kind: "relative"; ext: string }
    | { kind: "paths"; pattern: string; target: string; ext: string }
    | { kind: "baseUrl"; ext: string };

interface Resolved {
    abs: string;
    via: Via;
}

interface TsPaths {
    baseUrl?: string;
    paths: Array<{ pattern: string; targets: string[] }>;
    pathsBase: string;
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
    ".js": [".ts", ".tsx"],
    ".jsx": [".tsx"],
    ".mjs": [".mts"],
    ".cjs": [".cts"],
};
const TS_TO_JS: Record<string, string> = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };

const sourceExt = (file: string): string => {
    if (file.endsWith(".d.ts")) {
        return ".d.ts";
    }

    const ext = path.extname(file);
    return EXTENSIONS.includes(ext) ? ext : "";
};

const withoutExt = (file: string): string => {
    const ext = sourceExt(file);
    return ext === "" ? file : file.slice(0, -ext.length);
};

interface RawCompilerOptions {
    baseUrl?: unknown;
    paths?: unknown;
}

export interface Resolver {
    resolve: (fromFile: string, specifier: string) => Resolved | null;
    /** A specifier from `fromFile` to `targetAbs` in the style `via` names, falling back to relative. */
    specifierFor: (fromFile: string, targetAbs: string, via: Via) => string;
}

/** Resolves like TypeScript does for the cases a split meets: relative paths, `paths` and `baseUrl`. */
export const createResolver = (extraFiles: Set<string> = new Set()): Resolver => {
    const fileCache = new Map<string, boolean>();
    const isFile = (p: string): boolean => {
        if (extraFiles.has(p)) {
            return true;
        }

        let known = fileCache.get(p);
        if (known === undefined) {
            try {
                known = fs.statSync(p).isFile();
            } catch {
                known = false;
            }
            fileCache.set(p, known);
        }

        return known;
    };

    const probe = (base: string): string | null => {
        const swapped = (JS_TO_TS[path.extname(base)] ?? []).map(
            (ext) => base.slice(0, -path.extname(base).length) + ext
        );
        const candidates = [
            base,
            ...swapped,
            ...EXTENSIONS.map((ext) => base + ext),
            ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
        ];
        return candidates.find(isFile) ?? null;
    };

    const configFileCache = new Map<string, TsPaths | null>();
    const loadConfigFile = (file: string, depth: number): TsPaths | null => {
        const cached = configFileCache.get(file);
        if (cached !== undefined) {
            return cached;
        }

        let result: TsPaths | null = null;
        try {
            const raw = parseJsonc(fs.readFileSync(file, "utf8")) as {
                extends?: unknown;
                compilerOptions?: RawCompilerOptions;
            };
            const dir = path.dirname(file);
            const parents = (Array.isArray(raw.extends) ? raw.extends : [raw.extends]).filter(
                (e): e is string => typeof e === "string" && e.startsWith(".")
            );
            let inherited: TsPaths | null = null;
            for (const parent of parents) {
                const parentFile = path.resolve(dir, parent.endsWith(".json") ? parent : `${parent}.json`);
                inherited = (depth < 10 ? loadConfigFile(parentFile, depth + 1) : null) ?? inherited;
            }

            const options = raw.compilerOptions ?? {};
            const baseUrl =
                typeof options.baseUrl === "string" ? path.resolve(dir, options.baseUrl) : inherited?.baseUrl;
            const ownPaths =
                options.paths !== null && typeof options.paths === "object"
                    ? Object.entries(options.paths as Record<string, unknown>).map(([pattern, targets]) => ({
                          pattern,
                          targets: Array.isArray(targets)
                              ? targets.filter((t): t is string => typeof t === "string")
                              : [],
                      }))
                    : undefined;
            result = {
                ...(baseUrl === undefined ? {} : { baseUrl }),
                paths: ownPaths ?? inherited?.paths ?? [],
                pathsBase: baseUrl ?? (ownPaths === undefined ? (inherited?.pathsBase ?? dir) : dir),
            };
        } catch {
            result = null;
        }

        configFileCache.set(file, result);
        return result;
    };

    const dirConfigCache = new Map<string, TsPaths | null>();
    const configFor = (dir: string): TsPaths | null => {
        const cached = dirConfigCache.get(dir);
        if (cached !== undefined) {
            return cached;
        }

        let found: TsPaths | null = null;
        for (const name of ["tsconfig.json", "jsconfig.json"]) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) {
                found = loadConfigFile(candidate, 0);
                break;
            }
        }

        const parent = path.dirname(dir);
        if (found === null && parent !== dir) {
            found = configFor(parent);
        }

        dirConfigCache.set(dir, found);
        return found;
    };

    const resolve = (fromFile: string, specifier: string): Resolved | null => {
        if (specifier.startsWith(".")) {
            const abs = probe(path.resolve(path.dirname(fromFile), specifier));
            return abs === null ? null : { abs, via: { kind: "relative", ext: sourceExt(specifier) } };
        }

        const config = configFor(path.dirname(fromFile));
        if (config === null) {
            return null;
        }

        for (const { pattern, targets } of config.paths) {
            const star = pattern.indexOf("*");
            let middle: string | null = null;
            if (star === -1) {
                middle = specifier === pattern ? "" : null;
            } else {
                const pre = pattern.slice(0, star);
                const post = pattern.slice(star + 1);
                if (
                    specifier.startsWith(pre) &&
                    specifier.endsWith(post) &&
                    specifier.length >= pre.length + post.length
                ) {
                    middle = specifier.slice(pre.length, specifier.length - post.length);
                }
            }

            if (middle === null) {
                continue;
            }

            for (const target of targets) {
                const abs = probe(path.resolve(config.pathsBase, target.replace("*", middle)));
                if (abs !== null) {
                    return { abs, via: { kind: "paths", pattern, target, ext: sourceExt(specifier) } };
                }
            }
        }

        if (config.baseUrl !== undefined) {
            const abs = probe(path.resolve(config.baseUrl, specifier));
            if (abs !== null) {
                return { abs, via: { kind: "baseUrl", ext: sourceExt(specifier) } };
            }
        }

        return null;
    };

    /** `targetAbs` spelled the way the old specifier was: no extension, its own, or the .js form. */
    const spelled = (targetAbs: string, ext: string): string => {
        if (ext === "") {
            return withoutExt(targetAbs);
        }

        const own = sourceExt(targetAbs);
        return withoutExt(targetAbs) + (JS_TO_TS[ext] !== undefined ? (TS_TO_JS[own] ?? own) : own);
    };

    const relativeSpecifier = (fromFile: string, targetAbs: string, ext: string): string => {
        const rel = toPosix(path.relative(path.dirname(fromFile), spelled(targetAbs, ext)));
        return rel.startsWith(".") ? rel : `./${rel}`;
    };

    const specifierFor = (fromFile: string, targetAbs: string, via: Via): string => {
        const config = configFor(path.dirname(fromFile));
        const candidates: string[] = [];
        const viaPaths = (only?: string): void => {
            for (const { pattern, targets } of config?.paths ?? []) {
                if (only !== undefined && pattern !== only) {
                    continue;
                }

                for (const target of targets) {
                    const templateAbs = path.resolve(config?.pathsBase ?? "", target);
                    const star = templateAbs.indexOf("*");
                    for (const candidate of [spelled(targetAbs, via.ext), withoutExt(targetAbs), targetAbs]) {
                        if (star === -1) {
                            if (candidate === templateAbs) {
                                candidates.push(pattern);
                            }
                            continue;
                        }

                        const pre = templateAbs.slice(0, star);
                        const post = templateAbs.slice(star + 1);
                        if (candidate.startsWith(pre) && candidate.endsWith(post)) {
                            candidates.push(
                                pattern.replace(
                                    "*",
                                    toPosix(candidate.slice(pre.length, candidate.length - post.length))
                                )
                            );
                        }
                    }
                }
            }
        };
        const viaBaseUrl = (): void => {
            if (config?.baseUrl !== undefined) {
                for (const candidate of [spelled(targetAbs, via.ext), withoutExt(targetAbs)]) {
                    const rel = path.relative(config.baseUrl, candidate);
                    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
                        candidates.push(toPosix(rel));
                    }
                }
            }
        };

        if (via.kind === "paths") {
            viaPaths(via.pattern);
            viaPaths();
        } else if (via.kind === "baseUrl") {
            viaBaseUrl();
        }

        // A candidate counts only when it resolves back to the file it names: `paths` patterns
        // overlap, and a baseUrl path can be shadowed by a package of the same name.
        const checked = candidates.find((candidate) => resolve(fromFile, candidate)?.abs === targetAbs);
        return checked ?? relativeSpecifier(fromFile, targetAbs, via.ext);
    };

    return { resolve, specifierFor };
};

// ── planning ──────────────────────────────────────────────────────────────

interface Addition {
    keyword: "import" | "export";
    typeOnly: boolean;
    specifier: string;
    resolvedAbs: string | null;
    named?: NamedSpecifier[];
    defaultName?: string;
    namespace?: string;
    star?: boolean;
    /** Copy brace layout from this statement (the one a split came from). */
    layoutFrom?: ImportStatement;
}

interface FileStyle {
    /** The formatter's line width; undefined when the project configures no formatter. */
    width?: number;
    indent: string;
    trailingComma: boolean;
    quote: string;
    semicolon: boolean;
}

interface FilePlan {
    abs: string;
    display: string;
    text: string;
    statements: ImportStatement[];
    /** The file each statement resolves to, or null for a package. */
    resolved: Array<string | null>;
    /** Statement index → its new named list. */
    named: Map<number, NamedSpecifier[]>;
    /** Statement index → its new module, when every name it imports follows a move. */
    respecified: Map<number, { specifier: string; abs: string }>;
    removed: Set<number>;
    additions: Addition[];
    /** Names the file binds at top level (imports and declarations), for skipping duplicates. */
    bound: Set<string>;
    style: FileStyle;
}

/** Case-insensitive, the way biome and the common import sorters order module paths. */
const compareSpecifiers = (a: string, b: string): number => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    if (x !== y) {
        return x < y ? -1 : 1;
    }

    return a < b ? -1 : a > b ? 1 : 0;
};
const compareNames = (a: NamedSpecifier, b: NamedSpecifier): number => compareSpecifiers(a.imported, b.imported);

/** Insert `entries` into `list` at their alphabetical places, leaving the existing order alone. */
const mergeNamed = (list: NamedSpecifier[], entries: NamedSpecifier[]): NamedSpecifier[] => {
    const out = [...list];
    for (const entry of entries) {
        if (out.some((existing) => existing.local === entry.local)) {
            continue;
        }

        const at = out.findIndex((existing) => compareNames(existing, entry) > 0);
        out.splice(at === -1 ? out.length : at, 0, entry);
    }

    return out;
};

interface Layout {
    quote: string;
    semicolon: boolean;
    /** `auto` wraps exactly when the one-line form is wider than `width`, as a formatter would. */
    multiline: boolean | "auto";
    width?: number;
    indent: string;
    trailingComma: boolean;
}

const renderStatement = (
    head: { keyword: string; typeOnly: boolean; defaultName?: string; namespace?: string; star?: boolean },
    named: NamedSpecifier[] | undefined,
    specifier: string,
    layout: Layout
): string => {
    const build = (wrap: boolean): string => {
        const parts: string[] = [];
        if (head.defaultName !== undefined) {
            parts.push(head.defaultName);
        }

        if (head.namespace !== undefined) {
            parts.push(`* as ${head.namespace}`);
        }

        if (head.star === true) {
            parts.push("*");
        }

        if (named !== undefined && named.length > 0) {
            parts.push(
                wrap
                    ? `{\n${named.map((entry) => `${layout.indent}${entry.raw}`).join(",\n")}${layout.trailingComma ? "," : ""}\n}`
                    : `{ ${named.map((entry) => entry.raw).join(", ")} }`
            );
        }

        const typeWord = head.typeOnly ? " type" : "";
        return `${head.keyword}${typeWord} ${parts.join(", ")} from ${layout.quote}${specifier}${layout.quote}${layout.semicolon ? ";" : ""}`;
    };
    const single = build(false);
    const wrap =
        layout.multiline === "auto" ? layout.width !== undefined && single.length > layout.width : layout.multiline;
    return wrap ? build(true) : single;
};

interface FormatterConfig {
    width: number;
    indent: string;
    trailingComma: boolean;
}

const readFormatterConfig = (file: string): FormatterConfig | null => {
    let raw: unknown;
    try {
        raw = parseJsonc(fs.readFileSync(file, "utf8"));
    } catch {
        // A YAML .prettierrc, or a broken file: no width to follow.
        return null;
    }

    if (typeof raw === "string" && !path.basename(file).startsWith("biome")) {
        // `"eslint-config-x/.prettierrc"`: a shared config, read from the package itself.
        const shared = path.join(path.dirname(file), "node_modules", raw);
        return shared !== file && fs.existsSync(shared) ? readFormatterConfig(shared) : null;
    }

    if (raw === null || typeof raw !== "object") {
        return null;
    }

    const config = raw as Record<string, unknown>;
    if (path.basename(file).startsWith("biome")) {
        const general = (config.formatter ?? {}) as Record<string, unknown>;
        const js = ((config.javascript as Record<string, unknown> | undefined)?.formatter ?? {}) as Record<
            string,
            unknown
        >;
        // A project can configure a width and still switch the JS formatter off; then nothing
        // enforces the width, and each statement's own layout is the style to keep.
        if (general.enabled === false || js.enabled === false) {
            return null;
        }

        const style = asString(js.indentStyle) ?? asString(general.indentStyle) ?? "tab";
        const size = asNumber(js.indentWidth) ?? asNumber(general.indentWidth) ?? 2;
        return {
            width: asNumber(js.lineWidth) ?? asNumber(general.lineWidth) ?? 80,
            indent: style === "space" ? " ".repeat(size) : "\t",
            trailingComma: (asString(js.trailingCommas) ?? asString(js.trailingComma) ?? "all") !== "none",
        };
    }

    return {
        width: asNumber(config.printWidth) ?? 80,
        indent: config.useTabs === true ? "\t" : " ".repeat(asNumber(config.tabWidth) ?? 2),
        trailingComma: (asString(config.trailingComma) ?? "all") !== "none",
    };
};

const formatterCache = new Map<string, FormatterConfig | null>();
/** The nearest biome or prettier JSON config above `dir`. */
const formatterFor = (dir: string): FormatterConfig | null => {
    const cached = formatterCache.get(dir);
    if (cached !== undefined) {
        return cached;
    }

    let found: FormatterConfig | null = null;
    for (const name of ["biome.json", "biome.jsonc", ".prettierrc", ".prettierrc.json"]) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) {
            found = readFormatterConfig(candidate);
            if (found !== null) {
                break;
            }
        }
    }

    const parent = path.dirname(dir);
    if (found === null && parent !== dir) {
        found = formatterFor(parent);
    }

    formatterCache.set(dir, found);
    return found;
};

const fileStyle = (abs: string, text: string, statements: ImportStatement[]): FileStyle => {
    const sample = statements.find((statement) => statement.named !== undefined) ?? statements[0];
    const wrapped = statements.find((statement) => statement.multiline);
    const formatter = formatterFor(path.dirname(abs));
    return {
        ...(formatter === null ? {} : { width: formatter.width }),
        indent: wrapped?.indent ?? formatter?.indent ?? text.match(/^([ \t]+)\S/m)?.[1] ?? "    ",
        trailingComma: wrapped?.trailingComma ?? formatter?.trailingComma ?? true,
        quote: sample?.quote ?? '"',
        semicolon: sample?.semicolon ?? true,
    };
};

const isRelative = (specifier: string): boolean => specifier.startsWith(".");

/** Where a new statement goes: alphabetical by module path inside its group (relative or not). */
const placement = (
    plan: FilePlan,
    addition: Addition
): { index: number; before: boolean } | { index: -1; before: true } => {
    const same = plan.statements
        .map((statement, index) => ({ statement, index }))
        .filter(
            ({ statement }) =>
                statement.keyword === addition.keyword &&
                isRelative(statement.specifier) === isRelative(addition.specifier)
        );
    if (same.length > 0) {
        const after = same.find(({ statement }) => compareSpecifiers(statement.specifier, addition.specifier) > 0);
        return after === undefined
            ? { index: same[same.length - 1].index, before: false }
            : { index: after.index, before: true };
    }

    if (plan.statements.length === 0) {
        return { index: -1, before: true };
    }

    const firstRelative = plan.statements.findIndex((statement) => isRelative(statement.specifier));
    if (!isRelative(addition.specifier) && firstRelative !== -1 && addition.keyword === "import") {
        return { index: firstRelative, before: true };
    }

    return { index: plan.statements.length - 1, before: false };
};

/** The module a statement will import from once the plan is applied. */
const willResolveTo = (plan: FilePlan, index: number): string =>
    plan.respecified.get(index)?.abs ?? plan.resolved[index] ?? plan.statements[index].specifier;

const addTo = (plan: FilePlan, addition: Addition): void => {
    // An addition from a module the file already imports joins that statement.
    if (addition.named !== undefined && addition.resolvedAbs !== null) {
        const joinable = plan.statements.findIndex(
            (statement, index) =>
                !plan.removed.has(index) &&
                statement.keyword === addition.keyword &&
                statement.typeOnly === addition.typeOnly &&
                statement.named !== undefined &&
                willResolveTo(plan, index) === addition.resolvedAbs
        );
        if (joinable !== -1) {
            const current = plan.named.get(joinable) ?? plan.statements[joinable].named ?? [];
            plan.named.set(joinable, mergeNamed(current, addition.named));
            return;
        }

        const pending = plan.additions.find(
            (other) =>
                other.named !== undefined &&
                other.keyword === addition.keyword &&
                other.typeOnly === addition.typeOnly &&
                (other.resolvedAbs ?? other.specifier) === (addition.resolvedAbs ?? addition.specifier)
        );
        if (pending?.named !== undefined) {
            pending.named = mergeNamed(pending.named, addition.named);
            return;
        }
    }

    if (
        addition.star === true &&
        plan.statements.some(
            (statement, index) => statement.star && willResolveTo(plan, index) === addition.resolvedAbs
        )
    ) {
        return;
    }

    plan.additions.push({ ...addition });
};

/** `statement.text` with only its module path swapped, so the rest keeps its exact bytes. */
const withSpecifier = (statement: ImportStatement, specifier: string): string => {
    const quoted = `${statement.quote}${statement.specifier}${statement.quote}`;
    const at = statement.text.lastIndexOf(quoted);
    return `${statement.text.slice(0, at)}${statement.quote}${specifier}${statement.quote}${statement.text.slice(at + quoted.length)}`;
};

const planOps = (plan: FilePlan, label: string): Op[] => {
    const { style } = plan;
    const auto = style.width !== undefined;
    const render = (addition: Addition): string => {
        const from = addition.layoutFrom?.multiline === true ? addition.layoutFrom : undefined;
        return renderStatement(addition, addition.named, addition.specifier, {
            quote: style.quote,
            semicolon: style.semicolon,
            multiline: auto ? "auto" : from !== undefined,
            ...(style.width === undefined ? {} : { width: style.width }),
            indent: from?.indent ?? style.indent,
            trailingComma: from?.trailingComma ?? style.trailingComma,
        });
    };
    const before = new Map<number, string[]>();
    const after = new Map<number, string[]>();
    const top: string[] = [];
    const groupOrder = (a: Addition, b: Addition): number =>
        Number(isRelative(a.specifier)) - Number(isRelative(b.specifier)) ||
        compareSpecifiers(a.specifier, b.specifier);
    for (const addition of [...plan.additions].sort(groupOrder)) {
        const where = placement(plan, addition);
        if (where.index === -1) {
            top.push(render(addition));
            continue;
        }

        const bucket = where.before ? before : after;
        bucket.set(where.index, [...(bucket.get(where.index) ?? []), render(addition)]);
    }

    const ops: Op[] = [];
    for (const [index, statement] of plan.statements.entries()) {
        const named = plan.named.get(index);
        const respecified = plan.respecified.get(index);
        const removed = plan.removed.has(index);
        const extra = [...(before.get(index) ?? []), ...(after.get(index) ?? [])];
        if (named === undefined && respecified === undefined && !removed && extra.length === 0) {
            continue;
        }

        const specifier = respecified?.specifier ?? statement.specifier;
        const own = removed
            ? []
            : [
                  named === undefined
                      ? withSpecifier(statement, specifier)
                      : renderStatement(statement, named, specifier, {
                            quote: statement.quote,
                            semicolon: statement.semicolon,
                            multiline: auto ? "auto" : statement.multiline,
                            ...(style.width === undefined ? {} : { width: style.width }),
                            indent: statement.multiline ? statement.indent : style.indent,
                            trailingComma: statement.multiline ? statement.trailingComma : style.trailingComma,
                        }),
              ];
        const parts = [...(before.get(index) ?? []), ...own, ...(after.get(index) ?? [])];
        const eatsNewline = parts.length === 0 && plan.text[statement.end] === "\n";
        ops.push({
            find: eatsNewline ? `${statement.text}\n` : statement.text,
            replace: parts.join("\n"),
            label,
        });
    }

    if (top.length > 0) {
        const block = top.join("\n");
        ops.push({
            kind: "regex",
            // The file has no import yet: the block goes first, after a shebang and directives.
            find: /^(?:#![^\n]*\n)?(?:(['"])use [\w ]+\1;?[ \t]*\n)*/g,
            replace: (...args: unknown[]): string => {
                const prefix = String(args[0]);
                const whole = String(args[args.length - 1]);
                const rest = whole.slice(prefix.length);
                return `${prefix}${block}\n${rest.startsWith("\n") || rest.length === 0 ? "" : "\n"}`;
            },
            expect: 1,
            label,
        });
    }

    return ops;
};

/**
 * The import half of every `imports=fix` move: edits for each source, each target, and each file
 * that imported a moved export. Every edit is a literal op on one import statement.
 */
export const planTsImportFixes = (params: PlanImportFixesParams): FileEdit[] => {
    const { moves, cwd, read, projectFiles, onWarning } = params;
    const fixing = moves.filter((move) => move.fixImports);
    if (fixing.length === 0) {
        return [];
    }

    const resolver = createResolver(new Set(moves.map((move) => move.toAbs)));
    const display = (abs: string): string => toPosix(path.relative(cwd, abs));
    const plans = new Map<string, FilePlan>();
    const planFor = (abs: string): FilePlan => {
        let plan = plans.get(abs);
        if (plan === undefined) {
            const text = read(abs) ?? "";
            const masked = maskNonCode(text);
            const statements = parseImports(text, masked);
            const bound = new Set<string>();
            for (const statement of statements) {
                if (statement.keyword !== "import") {
                    continue;
                }

                for (const name of [
                    statement.defaultName,
                    statement.namespace,
                    ...(statement.named ?? []).map((n) => n.local),
                ]) {
                    if (name !== undefined) {
                        bound.add(name);
                    }
                }
            }

            for (const name of topLevelDeclarations(blankStatements(masked, statements)).names.keys()) {
                bound.add(name);
            }

            plan = {
                abs,
                display: display(abs),
                text,
                statements,
                resolved: statements.map((statement) => resolver.resolve(abs, statement.specifier)?.abs ?? null),
                named: new Map(),
                respecified: new Map(),
                removed: new Set(),
                additions: [],
                bound,
                style: fileStyle(abs, text, statements),
            };
            plans.set(abs, plan);
        }

        return plan;
    };

    /** How a file names other project files: the majority style of its own imports. */
    const styleOf = (plan: FilePlan): Via => {
        const counts = new Map<string, { via: Via; count: number }>();
        for (const statement of plan.statements) {
            const resolved = resolver.resolve(plan.abs, statement.specifier);
            if (resolved === null || resolved.abs.includes(`${path.sep}node_modules${path.sep}`)) {
                continue;
            }

            const key = resolved.via.kind === "paths" ? `paths:${resolved.via.pattern}` : resolved.via.kind;
            const entry = counts.get(key) ?? { via: resolved.via, count: 0 };
            entry.count++;
            counts.set(key, entry);
        }

        const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
        return best?.via ?? { kind: "relative", ext: "" };
    };

    const movedBySource = new Map<
        string,
        Map<string, { toAbs: string; exported: boolean; typeOnly: boolean; move: PlannedMove }>
    >();
    const sources = [...new Set(fixing.map((move) => move.fromAbs))];
    for (const sourceAbs of sources) {
        const sourceMoves = fixing.filter((move) => move.fromAbs === sourceAbs);
        const moved = new Map<string, { toAbs: string; exported: boolean; typeOnly: boolean; move: PlannedMove }>();
        for (const move of sourceMoves) {
            const masked = maskNonCode(move.blockText);
            if (parseImports(move.blockText, masked).length > 0) {
                throw new MoveError(
                    `move: ${move.label} includes an import statement; with imports=fix move code only, the imports follow by themselves`,
                    move.index
                );
            }

            const declared = topLevelDeclarations(masked);
            if (declared.exportDefault) {
                throw new MoveError(
                    `move: ${move.label} holds an export default; imports=fix re-points named exports only`,
                    move.index
                );
            }

            for (const [name, info] of declared.names) {
                moved.set(name, { toAbs: move.toAbs, exported: info.exported, typeOnly: info.typeOnly, move });
            }
        }
        movedBySource.set(sourceAbs, moved);

        const source = planFor(sourceAbs);
        let remainingText = source.text;
        for (const move of moves.filter((m) => m.fromAbs === sourceAbs)) {
            remainingText = remainingText.replace(move.cutText, "");
        }

        const remainingMasked = maskNonCode(remainingText);
        const remainingBody = blankStatements(remainingMasked, parseImports(remainingText, remainingMasked));
        const originalBody = blankStatements(maskNonCode(source.text), source.statements);
        const remainingDeclarations = topLevelDeclarations(remainingBody).names;
        const sourceStyle = styleOf(source);

        // The source: bindings only the blocks used go; moved exports it still uses come back in.
        for (const [index, statement] of source.statements.entries()) {
            if (statement.keyword !== "import") {
                continue;
            }

            const gone = (name: string): boolean => usesName(originalBody, name) && !usesName(remainingBody, name);
            const all = statement.named ?? [];
            const named = all.filter((entry) => !gone(entry.local));
            const heads = [statement.defaultName, statement.namespace].filter(
                (name): name is string => name !== undefined
            );
            const headsGone = heads.filter(gone);
            if (named.length === all.length && headsGone.length === 0) {
                continue;
            }

            if (named.length === 0 && headsGone.length === heads.length) {
                source.removed.add(index);
                continue;
            }

            // A default or namespace binding only the blocks used stays: a spare binding fails a
            // lint, never a build, and splitting `D, { a }` is not worth a rewrite.
            if (named.length !== all.length) {
                source.named.set(index, named);
            }
        }

        for (const [name, info] of moved) {
            if (!usesName(remainingBody, name)) {
                continue;
            }

            if (!info.exported) {
                throw new MoveError(
                    `move: ${display(sourceAbs)} still uses ${name} after the move, and ${name} is not exported. Export it in the block, or move its users too.`,
                    info.move.index
                );
            }

            addTo(source, {
                keyword: "import",
                typeOnly: false,
                specifier: resolver.specifierFor(sourceAbs, info.toAbs, sourceStyle),
                resolvedAbs: info.toAbs,
                named: [{ raw: info.typeOnly ? `type ${name}` : name, imported: name, local: name }],
            });
        }

        // Each target: the imports its new code uses, and the declarations it reaches back for.
        for (const targetAbs of [...new Set(sourceMoves.map((move) => move.toAbs))]) {
            const toTarget = sourceMoves.filter((move) => move.toAbs === targetAbs);
            const blocks = maskNonCode(toTarget.map((move) => move.blockText).join("\n"));
            const target = planFor(targetAbs);
            const localHere = new Set([...moved].filter(([, info]) => info.toAbs === targetAbs).map(([name]) => name));
            const needs = (name: string): boolean =>
                usesName(blocks, name) && !localHere.has(name) && !target.bound.has(name);

            for (const statement of source.statements) {
                if (statement.keyword !== "import") {
                    continue;
                }

                const resolved = resolver.resolve(sourceAbs, statement.specifier);
                if (resolved?.abs === targetAbs) {
                    continue;
                }

                const specifier = isRelative(statement.specifier)
                    ? resolved === null
                        ? toPosix(
                              path.relative(
                                  path.dirname(targetAbs),
                                  path.resolve(path.dirname(sourceAbs), statement.specifier)
                              )
                          ).replace(/^(?!\.)/, "./")
                        : resolver.specifierFor(targetAbs, resolved.abs, resolved.via)
                    : statement.specifier;
                const named = (statement.named ?? []).filter((entry) => needs(entry.local));
                const defaultName =
                    statement.defaultName !== undefined && needs(statement.defaultName)
                        ? statement.defaultName
                        : undefined;
                const namespace =
                    statement.namespace !== undefined && needs(statement.namespace) ? statement.namespace : undefined;
                if (defaultName !== undefined || namespace !== undefined) {
                    addTo(target, {
                        keyword: "import",
                        typeOnly: statement.typeOnly,
                        specifier,
                        resolvedAbs: resolved?.abs ?? null,
                        ...(defaultName === undefined ? {} : { defaultName }),
                        ...(namespace === undefined ? {} : { namespace }),
                    });
                }

                if (named.length > 0) {
                    addTo(target, {
                        keyword: "import",
                        typeOnly: statement.typeOnly,
                        specifier,
                        resolvedAbs: resolved?.abs ?? null,
                        named,
                    });
                }

                for (const name of [...named.map((entry) => entry.local), defaultName, namespace]) {
                    if (name !== undefined) {
                        target.bound.add(name);
                    }
                }
            }

            const reachBack = (
                name: string,
                fromAbs: string,
                info: { exported: boolean; typeOnly: boolean },
                index: number
            ): void => {
                const { exported } = info;
                if (!exported) {
                    throw new MoveError(
                        `move: the moved code uses ${name}, which stays in ${display(fromAbs)} and is not exported. Move it too, or export it.`,
                        index
                    );
                }

                addTo(target, {
                    keyword: "import",
                    typeOnly: false,
                    specifier: resolver.specifierFor(targetAbs, fromAbs, sourceStyle),
                    resolvedAbs: fromAbs,
                    named: [{ raw: info.typeOnly ? `type ${name}` : name, imported: name, local: name }],
                });
                target.bound.add(name);
            };
            for (const [name, info] of remainingDeclarations) {
                if (needs(name)) {
                    reachBack(name, sourceAbs, info, toTarget[0].index);
                }
            }

            for (const [name, info] of moved) {
                if (info.toAbs !== targetAbs && needs(name)) {
                    reachBack(name, info.toAbs, info, toTarget[0].index);
                }
            }
        }
    }

    // Every importer of a moved export follows it.
    const files = (projectFiles ?? listProjectFiles(cwd)).filter((file) => importLanguage(file) === "ts");
    for (const sourceAbs of sources) {
        const moved = movedBySource.get(sourceAbs) ?? new Map();
        const exported = new Map([...moved].filter(([, info]) => info.exported));
        if (exported.size === 0) {
            continue;
        }

        const stem = path.basename(withoutExt(sourceAbs));
        const hint = stem === "index" ? path.basename(path.dirname(sourceAbs)) : stem;
        for (const file of files) {
            if (file === sourceAbs) {
                continue;
            }

            const text = plans.get(file)?.text ?? read(file);
            if (text === undefined || !text.includes(hint)) {
                continue;
            }

            const statements = plans.get(file)?.statements ?? parseImports(text);
            const hits = statements
                .map((statement, index) => ({ statement, index }))
                .filter(({ statement }) => resolver.resolve(file, statement.specifier)?.abs === sourceAbs);
            for (const dynamic of text.matchAll(
                /\b(?:import|require|mock|doMock|requireActual|importActual)\s*\(\s*(['"])([^'"\n]+)\1/g
            )) {
                if (resolver.resolve(file, dynamic[2])?.abs === sourceAbs) {
                    onWarning?.(
                        `imports=fix: ${display(file)}:${lineOf(text, dynamic.index ?? 0)} names ${dynamic[2]} in a call; moved exports (${[...exported.keys()].join(", ")}) are not re-pointed there. Check it by hand.`
                    );
                }
            }

            if (hits.length === 0) {
                continue;
            }

            const plan = planFor(file);
            for (const { statement, index } of hits) {
                const via = resolver.resolve(file, statement.specifier)?.via ?? { kind: "relative", ext: "" };
                if (statement.star) {
                    for (const toAbs of new Set([...exported.values()].map((info) => info.toAbs))) {
                        if (toAbs !== file) {
                            addTo(plan, {
                                keyword: "export",
                                typeOnly: statement.typeOnly,
                                specifier: resolver.specifierFor(file, toAbs, via),
                                resolvedAbs: toAbs,
                                star: true,
                            });
                        }
                    }
                    continue;
                }

                if (statement.namespace !== undefined) {
                    const masked = maskNonCode(text);
                    const reached = [...exported.keys()].filter((name) =>
                        new RegExp(
                            `${identifierPattern(statement.namespace ?? "")}\\s*\\.\\s*${identifierPattern(name)}`
                        ).test(masked)
                    );
                    if (reached.length > 0) {
                        onWarning?.(
                            `imports=fix: ${display(file)}:${lineOf(text, statement.start)} reaches ${reached.join(", ")} through the namespace ${statement.namespace}; that cannot be re-pointed. Fix it by hand.`
                        );
                    }
                }

                const current = plan.named.get(index) ?? statement.named;
                if (current === undefined) {
                    continue;
                }

                const leaving = current.filter((entry) => exported.has(entry.imported));
                if (leaving.length === 0) {
                    continue;
                }

                const kept = current.filter((entry) => !exported.has(entry.imported));
                const destinations = new Set(leaving.map((entry) => exported.get(entry.imported)?.toAbs));
                const [only] = destinations;
                const whole =
                    kept.length === 0 &&
                    statement.defaultName === undefined &&
                    statement.namespace === undefined &&
                    destinations.size === 1 &&
                    only !== undefined &&
                    only !== file &&
                    !plan.named.has(index);
                if (whole) {
                    // Every name follows one move: swap the module path in place, so the line keeps
                    // its position and its bytes, which is the diff a person would write.
                    plan.respecified.set(index, { specifier: resolver.specifierFor(file, only, via), abs: only });
                    continue;
                }

                if (kept.length === 0 && statement.defaultName === undefined && statement.namespace === undefined) {
                    plan.removed.add(index);
                } else {
                    plan.named.set(index, kept);
                }

                for (const toAbs of new Set(leaving.map((entry) => exported.get(entry.imported)?.toAbs))) {
                    if (toAbs === undefined || toAbs === file) {
                        // The target imported what is now its own code.
                        continue;
                    }

                    addTo(plan, {
                        keyword: statement.keyword,
                        typeOnly: statement.typeOnly,
                        specifier: resolver.specifierFor(file, toAbs, via),
                        resolvedAbs: toAbs,
                        named: leaving.filter((entry) => exported.get(entry.imported)?.toAbs === toAbs),
                        layoutFrom: statement,
                    });
                }
            }
        }
    }

    const edits: FileEdit[] = [];
    for (const plan of plans.values()) {
        const ops = planOps(plan, "imports=fix");
        if (ops.length > 0) {
            edits.push({ file: plan.display, ops });
        }
    }

    for (const move of fixing) {
        const target = plans.get(move.toAbs);
        const source = plans.get(move.fromAbs);
        const crossing =
            target?.additions.some((a) => a.resolvedAbs === move.fromAbs) === true &&
            source?.additions.some((a) => a.resolvedAbs === move.toAbs) === true;
        if (crossing) {
            onWarning?.(
                `imports=fix: ${move.from} and ${move.to} now import each other. That is legal, but a top-level value read at load time can be undefined; consider moving the shared part too.`
            );
            break;
        }
    }

    return edits;
};
