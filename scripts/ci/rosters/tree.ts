/**
 * Tree rosters: guards that need the whole tree at once, where a pattern roster looks at one file.
 *
 * A pattern roster stops `fetch(` beside `Api.send`. It cannot stop the next `myParseTranscript`: a helper that
 * a shared module already exports, written again under the same name, under a new name, or reached through an
 * import that crosses a boundary nobody crossed before. Each of those is only visible against the other files:
 *
 *   roster-shared-export-redeclared   a function named like an export of `src/utils/**` (a copy affix removed:
 *                                     `myParseTranscript`, `parseTranscriptLocal`, `parseTranscript2`), declared
 *                                     outside its owner.
 *   roster-function-body-copied       a function whose body is the body of a `src/utils/**` export, whatever its
 *                                     name and whatever its parameters are called.
 *   roster-tool-dependency-added      a tool imports another tool it did not import before (or `src/utils` imports
 *                                     a tool): a new edge in the tool graph. Its manifest key is `from → to`.
 *
 * They share the manifest and its rule with the pattern rosters (`rosters.json`, a count only goes down), and
 * `generate.ts` writes and checks them. They are NOT in `lint-rules.ts`: one file cannot be judged alone, and the
 * inventory reads every source file. Measured 2026-11-12 on 7,522 files and 36,839 named functions: 5,157 function
 * names are exported from `src/utils/**`; 372 of them are declared again elsewhere (1,117 copies), and the body of
 * 42 of them exists elsewhere 186 times, 29 of those under another name (`isObject` as `isRecord`, `isPlainObject`,
 * `isJsonRecord`).
 */
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { findInFiles, type Lang, type NapiConfig, type SgNode } from "@ast-grep/napi";
import { isSuppressed, isTestFile, langFor, pluginsDisabledFor } from "../lint-rules";

export interface TreeMatch {
    /** The manifest key: the file, or for a dependency `from → to`. */
    key: string;
    file: string;
    line: number;
    /** What this match copies or crosses; it leads the printed line. */
    detail: string;
}

export interface TreeRoster {
    name: string;
    candidate: string;
    message: string;
    scan: (inventory: Inventory) => TreeMatch[];
}

export interface FunctionFact {
    file: string;
    line: number;
    name: string;
    exported: boolean;
    /** The body with comments and spacing dropped and the parameters renamed to their positions; "" when too short or too long to compare. */
    fingerprint: string;
}

export interface ImportFact {
    file: string;
    line: number;
    /** The imported module as a repo path (`src/hub/lib/x`), for a relative or an aliased specifier. */
    target: string;
}

export interface Inventory {
    functions: FunctionFact[];
    imports: ImportFact[];
}

/** A body shorter than this, normalised, is too common to call a copy (`return value`, a one-line guard). */
export const MIN_BODY_CHARS = 45;
/** A long function copied whole is rare and costly to fingerprint; the copies that come back are small helpers. */
export const MAX_BODY_CHARS = 2_000;

const FACTS: NapiConfig = {
    rule: {
        any: [
            { kind: "function_declaration" },
            {
                kind: "variable_declarator",
                has: { field: "value", any: [{ kind: "arrow_function" }, { kind: "function_expression" }] },
            },
            { kind: "import_statement" },
            { kind: "export_statement", has: { field: "source", kind: "string" } },
        ],
    },
};

const PARAMETER_PARENTS =
    /^(?:required_parameter|optional_parameter|rest_pattern|object_pattern|array_pattern|shorthand_property_identifier_pattern|pair_pattern|assignment_pattern|formal_parameters)$/;

/** The names a function's parameters bind, in order: `(value, { a, b }, ...rest)` gives value, a, b, rest. */
function parameterNames(fn: SgNode): string[] {
    const parameters = fn.field("parameters") ?? fn.field("parameter");

    if (!parameters) {
        return [];
    }

    if (parameters.kind() === "identifier") {
        return [parameters.text()];
    }

    const names: string[] = [];
    const kinds: NapiConfig = {
        rule: { any: [{ kind: "identifier" }, { kind: "shorthand_property_identifier_pattern" }] },
    };

    for (const id of parameters.findAll(kinds)) {
        const parent = id.parent();

        if (
            id.kind() === "shorthand_property_identifier_pattern" ||
            (parent && PARAMETER_PARENTS.test(String(parent.kind())))
        ) {
            names.push(id.text());
        }
    }

    return names;
}

const WORD_START = /[A-Za-z_$]/;
const WORD = /[\w$]/;

/**
 * A function body as a comparable string: comments and spacing dropped, each parameter replaced by `$<position>`.
 * Two copies that differ only in what they call their parameters, or in their comments, give the same string.
 * Strings are kept as written. Pure, and the same for the same text, which is all a comparison needs.
 */
export function fingerprint(body: string, parameters: readonly string[]): string {
    const position = new Map(parameters.map((name, index) => [name, index]));
    let out = "";
    let i = 0;

    while (i < body.length) {
        const char = body[i] ?? "";
        const next = body[i + 1];

        if (char === "/" && next === "/") {
            while (i < body.length && body[i] !== "\n") {
                i += 1;
            }
        } else if (char === "/" && next === "*") {
            const end = body.indexOf("*/", i + 2);
            i = end === -1 ? body.length : end + 2;
        } else if (char === '"' || char === "'" || char === "`") {
            const start = i;
            i += 1;

            while (i < body.length && body[i] !== char) {
                i += body[i] === "\\" ? 2 : 1;
            }

            i += 1;
            out += body.slice(start, i);
        } else if (WORD_START.test(char)) {
            const start = i;

            while (i < body.length && WORD.test(body[i] ?? "")) {
                i += 1;
            }

            const word = body.slice(start, i);
            const index = body[start - 1] === "." ? undefined : position.get(word);
            // A space only where two words would otherwise run together (`return value`).
            out += `${WORD.test(out[out.length - 1] ?? "") ? " " : ""}${index === undefined ? word : `$${index}`}`;
        } else if (/\s/.test(char)) {
            i += 1;
        } else {
            out += char;
            i += 1;
        }
    }

    return `${parameters.length}|${out}`;
}

function importTarget(file: string, specifier: string): string | null {
    if (specifier.startsWith(".")) {
        return normalize(join(dirname(file), specifier));
    }

    if (specifier.startsWith("@app/")) {
        return `src/${specifier.slice("@app/".length)}`;
    }

    if (specifier.startsWith("@genesiscz/utils")) {
        return `src/utils${specifier.slice("@genesiscz/utils".length)}`;
    }

    return null;
}

/**
 * The files a tree roster reads: the lint's set, minus tests, declaration files, what biome keeps plugins off, and
 * `plugins/`. A plugin file is copied out of this checkout and cannot import `src/utils`, so its own `isRecord` is
 * the rule there, not a copy (`.claude/rules/plugins.md`, `check-plugin-standalone.ts`).
 */
export function treeFiles(files: readonly string[]): string[] {
    return files.filter(
        (file) =>
            !file.startsWith("plugins/") &&
            /\.(?:ts|tsx|mts|cts)$/.test(file) &&
            !file.endsWith(".d.ts") &&
            !isTestFile(file) &&
            !pluginsDisabledFor(file)
    );
}

function factsOf(node: SgNode, file: string, into: Inventory): void {
    const kind = node.kind();
    const line = node.range().start.line + 1;

    if (kind === "import_statement" || kind === "export_statement") {
        const specifier = node.field("source")?.text().slice(1, -1);
        const target = specifier ? importTarget(file, specifier) : null;

        if (target) {
            into.imports.push({ file, line, target });
        }

        return;
    }

    const fn = kind === "function_declaration" ? node : node.field("value");
    const name = node.field("name")?.text();

    if (!fn || !name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
        return;
    }

    const holder = kind === "function_declaration" ? node.parent() : node.parent()?.parent();
    const body = fn.field("body")?.text() ?? "";
    const comparable = body.length >= MIN_BODY_CHARS && body.length <= MAX_BODY_CHARS * 2;
    const print = comparable ? fingerprint(body, parameterNames(fn)) : "";

    into.functions.push({
        file,
        line,
        name,
        exported: holder?.kind() === "export_statement",
        fingerprint: print.length >= MIN_BODY_CHARS && print.length <= MAX_BODY_CHARS ? print : "",
    });
}

/** Every named function and every in-repo import of `files`, read once, in parallel by ast-grep. */
export async function buildInventory(files: readonly string[]): Promise<Inventory> {
    const inventory: Inventory = { functions: [], imports: [] };
    const byLang = new Map<Lang, string[]>();

    for (const file of treeFiles(files)) {
        const lang = langFor(file);

        if (lang !== null) {
            byLang.set(lang, [...(byLang.get(lang) ?? []), file]);
        }
    }

    for (const [lang, paths] of byLang) {
        await findInFiles(lang, { paths, matcher: FACTS }, (error, nodes) => {
            if (error) {
                throw error;
            }

            for (const node of nodes) {
                factsOf(node, node.getRoot().filename(), inventory);
            }
        });
    }

    inventory.functions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    inventory.imports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

    return inventory;
}

const isShared = (file: string) => file.startsWith("src/utils/");

/** Two words or more, and long enough: `walk`, `text`, `git` and `count` are exported from utils and mean nothing alone. */
export function isDistinctName(name: string): boolean {
    return name.length >= 8 && /[a-z0-9][A-Z]/.test(name);
}

/** `local` is not here: `localTime` and `localDaysBefore` say what they compute, they do not mark a copy. */
const COPY_PREFIX = /^(?:_+|my|own|custom)(?=[A-Z_])/;
const COPY_SUFFIX = /(?:Local|Copy|V?\d+|_+)$/;
const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** The names `name` may be a copy of: itself, and itself with a copy affix removed (`myFoo`, `fooLocal`, `foo2`, `_foo`). */
export function copyNames(name: string): string[] {
    const rest = name.replace(COPY_PREFIX, "").replace(/^_+/, "");
    // Only a removed prefix lowers the next letter (`myParse` is `parse`); `RouterLink` is not `routerLink`.
    const bare = rest === name ? name : lowerFirst(rest);

    return [...new Set([name, bare, name.replace(COPY_SUFFIX, ""), bare.replace(COPY_SUFFIX, "")])].filter(
        (candidate) => candidate.length > 0
    );
}

/** Of several shared files that export one helper, the one nearest the root of `src/utils` is named as the owner. */
function nearest(a: FunctionFact, b: FunctionFact): number {
    return (
        a.file.split("/").length - b.file.split("/").length ||
        a.file.length - b.file.length ||
        a.file.localeCompare(b.file)
    );
}

function sharedExports(inventory: Inventory): Map<string, FunctionFact[]> {
    const owners = new Map<string, FunctionFact[]>();

    for (const fact of inventory.functions) {
        if (fact.exported && isShared(fact.file)) {
            owners.set(fact.name, [...(owners.get(fact.name) ?? []), fact]);
        }
    }

    return owners;
}

export const SHARED_EXPORT_REDECLARED: TreeRoster = {
    name: "roster-shared-export-redeclared",
    candidate: "D16",
    message:
        "This function has the name of a helper that src/utils already exports. Import the shared one; when it lacks " +
        "what you need, extend it there.",
    scan: (inventory) => {
        const owners = sharedExports(inventory);
        const matches: TreeMatch[] = [];

        for (const fact of inventory.functions) {
            for (const candidate of copyNames(fact.name)) {
                const owned = owners.get(candidate);

                if (!owned || !isDistinctName(candidate) || owned.some((owner) => owner.file === fact.file)) {
                    continue;
                }

                // An export of utils under its own name in another utils file is a second owner, not a copy.
                if (candidate === fact.name && fact.exported && isShared(fact.file)) {
                    continue;
                }

                matches.push({
                    key: fact.file,
                    file: fact.file,
                    line: fact.line,
                    detail: `${fact.name}: ${candidate === fact.name ? "" : `a renamed copy of ${candidate}, `}exported from ${[...owned].sort(nearest)[0]?.file}`,
                });
                break;
            }
        }

        return matches;
    },
};

export const FUNCTION_BODY_COPIED: TreeRoster = {
    name: "roster-function-body-copied",
    candidate: "D16",
    message:
        "This function's body is the body of a helper that src/utils exports, under this or another name. Import " +
        "the shared one instead of the copy.",
    scan: (inventory) => {
        const owners = new Map<string, FunctionFact>();

        for (const fact of inventory.functions) {
            const held = fact.fingerprint ? owners.get(fact.fingerprint) : undefined;

            if (fact.fingerprint && fact.exported && isShared(fact.file) && (!held || nearest(fact, held) < 0)) {
                owners.set(fact.fingerprint, fact);
            }
        }

        const matches: TreeMatch[] = [];

        for (const fact of inventory.functions) {
            const owner = fact.fingerprint ? owners.get(fact.fingerprint) : undefined;

            // Another export of utils with the same body is utils' own matter (two owners), not a tool's copy.
            if (!owner || owner.file === fact.file || (fact.exported && isShared(fact.file))) {
                continue;
            }

            matches.push({
                key: fact.file,
                file: fact.file,
                line: fact.line,
                detail: `${fact.name}: the body of ${owner.name} (${owner.file}:${owner.line})`,
            });
        }

        return matches;
    },
};

/**
 * The tool a path belongs to: the first folder under `src/` (`src/hub/lib/a.ts` and the import target `src/hub` are
 * both `hub`). A single-file tool (`src/x.ts`) has none here.
 */
export function toolOf(path: string): string | null {
    const first = /^src\/([^/]+)(\/)?/.exec(path);

    if (!first?.[1] || (first[2] === undefined && /\.[a-z]+$/.test(first[1]))) {
        return null;
    }

    return first[1];
}

export const TOOL_DEPENDENCY_ADDED: TreeRoster = {
    name: "roster-tool-dependency-added",
    candidate: "D16",
    message:
        "This import makes one tool depend on another tool for the first time (or src/utils on a tool). Move what " +
        "you need into src/utils and import it from there; a dependency between two tools that is wanted gets " +
        "`// lint-rules-ignore: <why>` on the import.",
    scan: (inventory) => {
        const first = new Map<string, TreeMatch>();

        for (const fact of inventory.imports) {
            const from = toolOf(fact.file);
            const to = toolOf(fact.target);

            // Everything may import utils; an import inside one tool is no edge.
            if (!from || !to || from === to || to === "utils") {
                continue;
            }

            const key = `${from} → ${to}`;

            if (!first.has(key)) {
                first.set(key, { key, file: fact.file, line: fact.line, detail: `${key}: ${fact.target}` });
            }
        }

        return [...first.values()];
    },
};

export const TREE_ROSTERS: readonly TreeRoster[] = [
    SHARED_EXPORT_REDECLARED,
    FUNCTION_BODY_COPIED,
    TOOL_DEPENDENCY_ADDED,
];

/** The matches whose line carries no `lint-rules-ignore`. `read` is injected so a test needs no files. */
export function unsuppressed(
    matches: readonly TreeMatch[],
    read: (file: string) => string = (file) => readFileSync(file, "utf8")
): TreeMatch[] {
    const lines = new Map<string, string[]>();

    return matches.filter((match) => {
        if (!lines.has(match.file)) {
            lines.set(match.file, read(match.file).split("\n"));
        }

        return !isSuppressed(lines.get(match.file) ?? [], match.line);
    });
}

export function countByKey(matches: readonly TreeMatch[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const match of [...matches].sort((a, b) => a.key.localeCompare(b.key))) {
        counts[match.key] = (counts[match.key] ?? 0) + 1;
    }

    return counts;
}
