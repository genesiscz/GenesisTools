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
import { createRequire } from "node:module";
import * as path from "node:path";
import type * as TS from "typescript";

import { scanComments } from "./comments";
import { identifierPattern } from "./internal";
import {
    asNumber,
    asString,
    importLanguage,
    lineOf,
    listProjectFiles,
    literalOpSpec,
    MoveError,
    markerWith,
    type PlanImportFixesParams,
    type PlannedMove,
    parseJsonc,
    toPosix,
    usesName,
    warnWithFix,
    withFix,
} from "./move-imports-shared";
import { compilerReader } from "./move-imports-ts-compiler";
import type { FileEdit, Op } from "./types";

export interface NamedSpecifier {
    /** The entry as written: `type Foo`, `a as b`. */
    raw: string;
    imported: string;
    local: string;
    /** Comments on the entry's own lines above it, and after it on its line; they move with it. */
    comments?: { leading: string[]; trailing?: string };
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
    return blankSpans(text, [...comments, ...literals]);
};

/** `text` with each span replaced by spaces; newlines stay, so every offset still points at the same place. */
const blankSpans = (text: string, spans: Array<{ start: number; end: number }>): string => {
    const chars = text.split("");
    for (const span of spans) {
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

/**
 * The entries of an import list with their comments. `inner` has its comments blanked; `rawInner`
 * is the same span as written. A comment on its own line belongs to the entry below it, a comment
 * after an entry on its line belongs to that entry, so a re-rendered list loses no comment.
 */
export const parseNamedWithComments = (rawInner: string, inner: string): NamedSpecifier[] => {
    const commentsIn = (from: number, to: number): string[] =>
        to <= from ? [] : scanComments(rawInner.slice(from, to)).map((span) => span.text.trim());
    const out: NamedSpecifier[] = [];
    let freeFrom = 0;
    let segmentStart = 0;
    while (segmentStart <= inner.length) {
        const found = inner.indexOf(",", segmentStart);
        const comma = found === -1 ? inner.length : found;
        const segment = inner.slice(segmentStart, comma);
        const core = segment.trim();
        if (core.length > 0) {
            const coreStart = segmentStart + segment.indexOf(core);
            const coreEnd = coreStart + core.length;
            const rest = inner.slice(comma + 1);
            const nextCore = comma + 1 + (rest.length - rest.trimStart().length);
            const newline = rawInner.indexOf("\n", coreEnd);
            const lineEnd = Math.min(
                newline === -1 ? rawInner.length : newline,
                found === -1 ? rawInner.length : nextCore
            );
            const leading = commentsIn(freeFrom, coreStart);
            const trailing = commentsIn(coreEnd, lineEnd);
            const [entry] = parseNamed(core);
            out.push(
                leading.length + trailing.length === 0
                    ? entry
                    : {
                          ...entry,
                          comments: { leading, ...(trailing.length > 0 ? { trailing: trailing.join(" ") } : {}) },
                      }
            );
            freeFrom = lineEnd;
        }

        segmentStart = comma + 1;
    }

    const tail = commentsIn(freeFrom, rawInner.length);
    const last = out[out.length - 1];
    if (tail.length > 0 && last !== undefined) {
        const trailing = [last.comments?.trailing, ...tail].filter((c): c is string => c !== undefined).join(" ");
        out[out.length - 1] = { ...last, comments: { leading: last.comments?.leading ?? [], trailing } };
    }

    return out;
};

/** Every static `import … from` and `export … from` statement of `text`, in file order. */
export const parseImports = (text: string, masked: string = maskNonCode(text)): ImportStatement[] => {
    const statements: ImportStatement[] = [];
    // Matched on the text with only its comments blanked: a `}` or `from` in a comment inside the
    // braces cannot end the statement, while the module path, a string, stays readable.
    const commentless = blankSpans(text, scanComments(text));
    for (const match of commentless.matchAll(STATEMENT)) {
        const start = match.index ?? 0;
        // A statement-shaped line inside a comment or a template is text, not an import.
        if (masked[start] !== text[start]) {
            continue;
        }

        const [whole, keyword, typeWord, clause, quote, specifier, semicolon] = match;
        const braceAt = clause.indexOf("{");
        const head = (braceAt === -1 ? clause : clause.slice(0, braceAt)).replace(/,\s*$/, "").trim();
        const inner = braceAt === -1 ? undefined : clause.slice(braceAt + 1, clause.lastIndexOf("}"));
        const clauseAt = start + whole.indexOf(clause, keyword.length);
        const rawInner =
            inner === undefined ? undefined : text.slice(clauseAt + braceAt + 1, clauseAt + braceAt + 1 + inner.length);
        const namespace = head.match(/^\*\s+as\s+([\w$]+)$/)?.[1];
        const star = head === "*";
        const defaultName = namespace === undefined && !star && head.length > 0 ? head : undefined;
        const firstEntryLine = inner?.split("\n").find((line, k) => k > 0 && line.trim().length > 0);
        statements.push({
            start,
            end: start + whole.length,
            text: text.slice(start, start + whole.length),
            keyword: keyword === "export" ? "export" : "import",
            typeOnly: typeWord !== undefined,
            ...(defaultName === undefined ? {} : { defaultName }),
            ...(namespace === undefined ? {} : { namespace }),
            ...(inner === undefined || rawInner === undefined
                ? {}
                : { named: parseNamedWithComments(rawInner, inner) }),
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

export interface DeclarationInfo {
    exported: boolean;
    /** An interface or type alias, which an import must name with `type`. */
    typeOnly: boolean;
    /** The declaration's first line as written, the anchor a `visibility=widen` export edits. */
    line: string;
}

export interface Declarations {
    names: Map<string, DeclarationInfo>;
    exportDefault: boolean;
}

const DECLARATION_LINE =
    /^(export[ \t]+)?(default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(const[ \t]+enum|function\*?|class|interface|type|enum|const|let|var|namespace)[ \t]+([\w$]+)/gm;
const LOCAL_EXPORT_LIST = /^export[ \t]+(?:type[ \t]+)?\{([^}]*)\}(?!\s*from\b)/gm;

/** Declarations that start at column 0 of `masked`: a split's unit is a top-level declaration. */
export const topLevelDeclarations = (masked: string, raw: string = masked): Declarations => {
    const names = new Map<string, DeclarationInfo>();
    for (const match of masked.matchAll(DECLARATION_LINE)) {
        const name = match[4];
        const known = names.get(name);
        const exported = match[1] !== undefined || known?.exported === true;
        // A function or namespace merging with an interface of the same name is a value too.
        const typeOnly = (match[3] === "interface" || match[3] === "type") && known?.typeOnly !== false;
        const at = match.index ?? 0;
        const end = raw.indexOf("\n", at);
        names.set(name, { exported, typeOnly, line: known?.line ?? raw.slice(at, end === -1 ? undefined : end) });
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
    /** Specifiers a `paths` entry gives `targetAbs` (`"@helpers"`, `"@acme/ui"`); they need not spell its name. */
    aliasSpecifiers: (fromDir: string, targetAbs: string) => string[];
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

    const aliasSpecifiers = (fromDir: string, targetAbs: string): string[] => {
        const config = configFor(fromDir);
        if (config === null) {
            return [];
        }

        // A wildcard target can name the file, the file without its extension, or an index's folder.
        const forms = [targetAbs, withoutExt(targetAbs)];
        if (path.basename(withoutExt(targetAbs)) === "index") {
            forms.push(path.dirname(targetAbs));
        }

        const specifiers: string[] = [];
        for (const { pattern, targets } of config.paths) {
            for (const target of targets) {
                const template = path.resolve(config.pathsBase, target);
                const star = template.indexOf("*");
                if (!pattern.includes("*") || star === -1) {
                    if (!pattern.includes("*") && probe(template) === targetAbs) {
                        specifiers.push(pattern);
                    }

                    continue;
                }

                const pre = template.slice(0, star);
                const post = template.slice(star + 1);
                for (const form of forms) {
                    if (form.startsWith(pre) && form.endsWith(post) && form.length >= pre.length + post.length) {
                        specifiers.push(
                            pattern.replace("*", toPosix(form.slice(pre.length, form.length - post.length)))
                        );
                    }
                }
            }
        }

        return specifiers;
    };

    return { resolve, specifierFor, aliasSpecifiers };
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
    /** Ops that are not about import statements, such as an `export` a widened move adds. */
    extraOps: Op[];
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
                    ? `{\n${named
                          .flatMap((entry, k) => {
                              const comma = k < named.length - 1 || layout.trailingComma ? "," : "";
                              const trailing =
                                  entry.comments?.trailing === undefined ? "" : ` ${entry.comments.trailing}`;
                              return [
                                  ...(entry.comments?.leading ?? []).map((comment) => `${layout.indent}${comment}`),
                                  `${layout.indent}${entry.raw}${comma}${trailing}`,
                              ];
                          })
                          .join("\n")}\n}`
                    : `{ ${named.map((entry) => entry.raw).join(", ")} }`
            );
        }

        const typeWord = head.typeOnly ? " type" : "";
        return `${head.keyword}${typeWord} ${parts.join(", ")} from ${layout.quote}${specifier}${layout.quote}${layout.semicolon ? ";" : ""}`;
    };
    const single = build(false);
    // A line comment cannot sit inside a one-line list, so a list that carries comments wraps.
    const commented = named?.some((entry) => entry.comments !== undefined) === true;
    const wrap =
        commented ||
        (layout.multiline === "auto" ? layout.width !== undefined && single.length > layout.width : layout.multiline);
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

    // Every import went and none came: the blank line under the old block would open the file.
    // An optional op after all others, so it cannot collide with a cut that took a line already.
    if (plan.statements.length > 0 && plan.removed.size === plan.statements.length && plan.additions.length === 0) {
        ops.push({
            kind: "regex",
            find: /^\n+/g,
            replace: "",
            optional: true,
            label: `${label}: no empty line above the code`,
        });
    }

    ops.push(...plan.extraOps);
    return ops;
};

/** The op a `visibility=widen` move adds: `export` in front of a declaration's first line. */
const exportOp = (name: string, line: string): Op => ({
    find: line,
    replace: `export ${line}`,
    label: `imports=fix: export ${name}`,
});

/** A refusal's fix for a block that holds import lines: the same move, minus the lines they take. */
const importFreeRange = (move: PlannedMove, statements: ImportStatement[]): { why: string; spec: string } => {
    const lines = move.blockText.split("\n");
    const lastImportLine = Math.max(...statements.map((s) => lineOf(move.blockText, s.end) - 1));
    let first = lastImportLine + 1;
    while (first < lines.length && lines[first].trim() === "") {
        first++;
    }

    const leading =
        statements.every((s) => lineOf(move.blockText, s.start) - 1 <= lastImportLine) && first < lines.length;
    const range = `lines=${move.startLine + first}-${move.endLine}`;
    return leading
        ? {
              why: "start the range after the import lines; imports=fix carries the imports itself:",
              spec: move.marker.replace(/symbol=\S+|lines=\S+/, range),
          }
        : {
              why: `write a lines= range without the import lines (block lines ${move.startLine}-${move.endLine}); imports=fix carries the imports itself:`,
              spec: move.marker,
          };
};

const pascal = (stem: string): string =>
    stem
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part.length > 0)
        .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
        .join("");

/** A namespace import that reaches moved names: a second namespace for the new module, and the uses re-pointed. */
const namespaceFix = ({
    file,
    text,
    statement,
    reached,
    resolver,
    via,
    exported,
    display,
}: {
    file: string;
    text: string;
    statement: ImportStatement;
    reached: string[];
    resolver: Resolver;
    via: Via;
    exported: Map<string, { toAbs: string }>;
    display: (abs: string) => string;
}): { abs: string; needles: string[]; message: string; fix: { why: string; spec: string } } => {
    const ns = statement.namespace ?? "";
    const destination = exported.get(reached[0])?.toAbs ?? file;
    const alias = `${ns}${pascal(path.basename(withoutExt(destination)))}`;
    const pattern = `(?<![\\w$.])${ns.replace(/\$/g, "\\$")}\\.(${reached.map((name) => name.replace(/\$/g, "\\$")).join("|")})\\b`;
    const count = [...text.matchAll(new RegExp(pattern, "g"))].length;
    const newImport = `import * as ${alias} from ${statement.quote}${resolver.specifierFor(file, destination, via)}${statement.quote};`;
    return {
        abs: file,
        needles: reached.map((name) => `${ns}.${name}`),
        message: `imports=fix: ${display(file)}:${lineOf(text, statement.start)} reaches ${reached.join(", ")} through the namespace ${ns}, which no longer has them`,
        fix: {
            why: `import the new module as ${alias} and point those uses at it:`,
            spec: `${literalOpSpec(display(file), statement.text, `${statement.text}\n${newImport}`)}\n<<< regex count=${count}\n${pattern}\n===\n${alias}.$1\n>>>`,
        },
    };
};

/**
 * How the planner reads TypeScript: which statements are imports, which declarations a text makes,
 * and which names it refers to (its own import statements excluded). Two readers answer it: the
 * compiler's syntax tree when a GenesisTools checkout provides `typescript`, else patterns.
 */
export interface TsReader {
    kind: "compiler" | "text";
    imports: (text: string, file: string) => ImportStatement[];
    declarations: (text: string, file: string) => Declarations;
    uses: (text: string, file: string) => (name: string) => boolean;
}

export const textReader: TsReader = {
    kind: "text",
    imports: (text) => parseImports(text),
    declarations: (text) => {
        const masked = maskNonCode(text);
        return topLevelDeclarations(blankStatements(masked, parseImports(text, masked)), text);
    },
    uses: (text) => {
        const masked = maskNonCode(text);
        const body = blankStatements(masked, parseImports(text, masked));
        return (name) => usesName(body, name);
    },
};

let selected: { reader: TsReader; fallback?: string } | undefined;

/**
 * The compiler reader when a GenesisTools checkout with `typescript` is found, else the text
 * reader and the reason. `FABLE_REPLACE_PARSER=text` forces the text reader (tests, comparisons).
 */
export const selectTsReader = (): { reader: TsReader; fallback?: string } => {
    if (selected !== undefined) {
        return selected;
    }

    // lint-rules-ignore: standalone plugin script without access to @genesiscz/utils/env
    if (process.env.FABLE_REPLACE_PARSER === "text") {
        selected = { reader: textReader };
        return selected;
    }

    // Loaded, not imported: these scripts also run copied on their own, without the plugin's lib/.
    const locatorFile = path.join(import.meta.dir, "..", "..", "..", "lib", "locate-genesis-tools.ts");
    if (!fs.existsSync(locatorFile)) {
        selected = {
            reader: textReader,
            fallback: `the plugin's lib/ folder is not beside these scripts (${locatorFile})`,
        };
        return selected;
    }

    const locator = createRequire(import.meta.url)(
        locatorFile
    ) as typeof import("../../../lib/locate-genesis-tools.ts");
    const install = locator.locateGenesisTools();
    if (install === null) {
        selected = { reader: textReader, fallback: "no GenesisTools checkout with node_modules/typescript was found" };
        return selected;
    }

    try {
        selected = { reader: compilerReader(locator.requireTypeScript(install) as typeof TS) };
    } catch (error) {
        selected = { reader: textReader, fallback: `loading typescript from ${install.root} failed: ${String(error)}` };
    }

    return selected;
};

/**
 * The import half of every `imports=fix` move: edits for each source, each target, and each file
 * that imported a moved export. Every edit is a literal op on one import statement.
 */
export const planTsImportFixes = (params: PlanImportFixesParams): FileEdit[] => {
    const { moves, cwd, read, projectFiles } = params;
    const fixing = moves.filter((move) => move.fixImports);
    if (fixing.length === 0) {
        return [];
    }

    const { reader, fallback } = selectTsReader();
    if (fallback !== undefined) {
        warnWithFix(params, {
            abs: cwd,
            needles: [],
            message: `imports=fix: ${fallback}, so TypeScript is read with patterns; a local name that shadows an import can then keep a spare import`,
            fix: {
                why: "install GenesisTools once and run any `tools` command (it records where it lives), or point GENESIS_TOOLS_PATH at a checkout that has node_modules: git clone https://github.com/genesiscz/GenesisTools.git ~/GenesisTools && cd ~/GenesisTools && ./install.sh",
            },
        });
    }

    const resolver = createResolver(new Set(moves.map((move) => move.toAbs)));
    const display = (abs: string): string => toPosix(path.relative(cwd, abs));
    const plans = new Map<string, FilePlan>();
    const planFor = (abs: string): FilePlan => {
        let plan = plans.get(abs);
        if (plan === undefined) {
            const text = read(abs) ?? "";
            const statements = reader.imports(text, abs);
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

            for (const name of reader.declarations(text, abs).names.keys()) {
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
                extraOps: [],
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

    const movedBySource = new Map<string, Map<string, DeclarationInfo & { toAbs: string; move: PlannedMove }>>();
    const sources = [...new Set(fixing.map((move) => move.fromAbs))];
    for (const sourceAbs of sources) {
        const sourceMoves = fixing.filter((move) => move.fromAbs === sourceAbs);
        const moved = new Map<string, DeclarationInfo & { toAbs: string; move: PlannedMove }>();
        for (const move of sourceMoves) {
            const inBlock = reader.imports(move.blockText, move.fromAbs);
            if (inBlock.length > 0) {
                throw new MoveError(
                    withFix(`move: ${move.label} includes an import statement`, importFreeRange(move, inBlock)),
                    move.index
                );
            }

            const declared = reader.declarations(move.blockText, move.fromAbs);
            if (declared.exportDefault) {
                throw new MoveError(
                    withFix(
                        `move: ${move.label} holds an export default, and imports=fix re-points named exports only`,
                        {
                            why: "move it without imports=fix and fix its importers by hand, or name the export in a run of its own first:",
                            spec: move.marker.replace(" imports=fix", "").replace(" visibility=widen", ""),
                        }
                    ),
                    move.index
                );
            }

            for (const [name, info] of declared.names) {
                moved.set(name, { ...info, toAbs: move.toAbs, move });
            }
        }
        movedBySource.set(sourceAbs, moved);

        const source = planFor(sourceAbs);
        let remainingText = source.text;
        for (const move of moves.filter((m) => m.fromAbs === sourceAbs)) {
            remainingText = remainingText.replace(move.cutText, "");
        }

        const usedBefore = reader.uses(source.text, sourceAbs);
        const usedAfter = reader.uses(remainingText, sourceAbs);
        const remainingDeclarations = reader.declarations(remainingText, sourceAbs).names;
        const sourceStyle = styleOf(source);

        // The source: bindings only the blocks used go; moved exports it still uses come back in.
        for (const [index, statement] of source.statements.entries()) {
            if (statement.keyword !== "import") {
                continue;
            }

            const gone = (name: string): boolean => usedBefore(name) && !usedAfter(name);
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
            if (!usedAfter(name)) {
                continue;
            }

            if (!info.exported) {
                if (!info.move.widen) {
                    throw new MoveError(
                        withFix(
                            `move: ${display(sourceAbs)} still uses ${name} after the move, and ${name} is not exported`,
                            {
                                why: "let the move export it, or move its users along:",
                                spec: markerWith(info.move, "visibility=widen"),
                            }
                        ),
                        info.move.index
                    );
                }

                planFor(info.toAbs).extraOps.push(exportOp(name, info.line));
                info.exported = true;
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
            const blockUses = reader.uses(toTarget.map((move) => move.blockText).join("\n"), sourceAbs);
            const target = planFor(targetAbs);
            const localHere = new Set([...moved].filter(([, info]) => info.toAbs === targetAbs).map(([name]) => name));
            const needs = (name: string): boolean => blockUses(name) && !localHere.has(name) && !target.bound.has(name);

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

            const reachBack = (name: string, fromAbs: string, info: DeclarationInfo, index: number): void => {
                if (!info.exported) {
                    const first = toTarget[0];
                    if (!toTarget.some((move) => move.widen)) {
                        throw new MoveError(
                            withFix(
                                `move: the moved code uses ${name}, which stays in ${display(fromAbs)} and is not exported`,
                                {
                                    why: "move it along (first line), or let the move export it (second line):",
                                    spec: `<<< move to=${first.to} symbol=${name} imports=fix\n${markerWith(first, "visibility=widen")}`,
                                }
                            ),
                            index
                        );
                    }

                    planFor(fromAbs).extraOps.push(exportOp(name, info.line));
                    info.exported = true;
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

        // A cheap pre-filter before resolving every statement: an importer's specifier spells the
        // file's name or its folder's, unless an exact `paths` alias (`"@helpers"`) names it.
        // The alias comes from the importer's own tsconfig, which in a monorepo is not the source's.
        // An index file is also reached through a bare `"."` or `".."`, which spells no name at all.
        const stem = path.basename(withoutExt(sourceAbs));
        const nameHint = stem === "index" ? path.basename(path.dirname(sourceAbs)) : stem;
        const bareRelative = stem === "index" ? /(['"])\.\.?(?:\/\.\.)*\/?\1/ : null;
        const aliasHints = new Map<string, string[]>();
        const hintsFor = (dir: string): string[] => {
            let aliases = aliasHints.get(dir);
            if (aliases === undefined) {
                aliases = resolver.aliasSpecifiers(dir, sourceAbs);
                aliasHints.set(dir, aliases);
            }

            return [nameHint, ...aliases];
        };
        const mayImport = (file: string, text: string): boolean =>
            hintsFor(path.dirname(file)).some((hint) => text.includes(hint)) || (bareRelative?.test(text) ?? false);
        for (const file of files) {
            if (file === sourceAbs) {
                continue;
            }

            const text = plans.get(file)?.text ?? read(file);
            if (text === undefined || !mayImport(file, text)) {
                continue;
            }

            const statements = plans.get(file)?.statements ?? reader.imports(text, file);
            const hits = statements
                .map((statement, index) => ({ statement, index }))
                .filter(({ statement }) => resolver.resolve(file, statement.specifier)?.abs === sourceAbs);
            for (const dynamic of text.matchAll(
                /\b(?:import|require|mock|doMock|requireActual|importActual)\s*\(\s*(['"])([^'"\n]+)\1/g
            )) {
                const called = resolver.resolve(file, dynamic[2]);
                if (called?.abs === sourceAbs) {
                    const call = dynamic[0];
                    const destination = [...exported.values()][0].toAbs;
                    const quote = dynamic[1];
                    const newSpecifier = resolver.specifierFor(file, destination, called.via);
                    warnWithFix(params, {
                        abs: file,
                        needles: [call],
                        message: `imports=fix: ${display(file)}:${lineOf(text, dynamic.index ?? 0)} names ${dynamic[2]} in a call, and ${[...exported.keys()].join(", ")} moved out of it`,
                        fix: {
                            why: "point the call at the new module (keep the old call too if it must still cover the names that stay):",
                            spec: literalOpSpec(
                                display(file),
                                call,
                                call.replace(`${quote}${dynamic[2]}${quote}`, `${quote}${newSpecifier}${quote}`)
                            ),
                        },
                    });
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
                        warnWithFix(
                            params,
                            namespaceFix({ file, text, statement, reached, resolver, via, exported, display })
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
            const shared = (target?.additions ?? [])
                .filter((addition) => addition.resolvedAbs === move.fromAbs)
                .flatMap((addition) => (addition.named ?? []).map((entry) => entry.imported));
            const stem = path.basename(withoutExt(move.fromAbs));
            const sharedFile = toPosix(path.join(path.dirname(move.from), `${stem}-shared${path.extname(move.from)}`));
            warnWithFix(params, {
                abs: move.fromAbs,
                needles: [],
                message: `imports=fix: ${move.from} and ${move.to} now import each other; legal, but a top-level value read at load time can be undefined`,
                fix: {
                    why: "move what both use into a third file, so the two stop importing each other:",
                    spec: `@@ ${move.from}\n${shared.map((name) => `<<< move to=${sharedFile} symbol=${name} imports=fix\n>>>`).join("\n")}`,
                },
            });
            break;
        }
    }

    return edits;
};
