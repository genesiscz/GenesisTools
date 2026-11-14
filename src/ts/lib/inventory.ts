/**
 * The function inventory of a set of TypeScript files: every named function (its name, whether it is exported, a
 * fingerprint of its body) and every in-repo import. `tools ts copies` prints what it finds, and the tree rosters of
 * `scripts/ci/rosters/tree.ts` guard the same facts, so the CLI and the lint never disagree.
 *
 * The fingerprint is what `tools ts duplicates` does not do: it renames parameters to their positions and drops
 * comments and spacing, so `isRecord(value)`, `isPlainObject(input)` and `isJsonObject(v)` with one body are one
 * group (measured 2026-11-12: the `isObject` body 86 times under 7 names; `duplicates` reports 73).
 */
import { dirname, join, normalize } from "node:path";
import { findInFiles, Lang, type NapiConfig, type SgNode } from "@ast-grep/napi";

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
            // `await import("@app/question/lib/verbs")` is a dependency too.
            { kind: "call_expression", has: { field: "function", kind: "import" } },
        ],
    },
};

/** The module a dynamic `import(…)` names, when it is a literal: `"x"`, or a template with no `${…}` in it. */
function dynamicImportSpecifier(call: SgNode): string | undefined {
    const argument = call
        .field("arguments")
        ?.children()
        .find((child) => child.kind() === "string" || child.kind() === "template_string");

    if (!argument || (argument.kind() === "template_string" && argument.text().includes("${"))) {
        return undefined;
    }

    return argument.text().slice(1, -1);
}

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

/** After one of these characters a `/` opens a regular expression; after a value (`)`, `]`, a name) it divides. */
const REGEX_AFTER_CHAR = /[(,=:[!&|?{};+\-*%<>~^]/;
/** The keywords after which a `/` opens a regular expression (`return /a b/.test(x)`). */
const REGEX_AFTER_WORD = new Set([
    "return",
    "typeof",
    "case",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "throw",
    "else",
    "do",
    "yield",
    "await",
    "instanceof",
]);

/** The keywords whose parenthesized head is followed by a statement, so a `/` after the `)` opens a regex. */
const CONTROL_HEAD_WORDS = new Set(["if", "while", "for", "with"]);

/** The end (exclusive, flags included) of the regular expression literal at `start`, or -1 when it is none. */
function regexLiteralEnd(body: string, start: number): number {
    let i = start + 1;
    let inClass = false;

    while (i < body.length) {
        const char = body[i];

        if (char === "\n") {
            return -1;
        }

        if (char === "\\") {
            i += 2;
            continue;
        }

        if (char === "[") {
            inClass = true;
        } else if (char === "]") {
            inClass = false;
        } else if (char === "/" && !inClass) {
            i += 1;

            while (i < body.length && /[a-z]/i.test(body[i] ?? "")) {
                i += 1;
            }

            return i;
        }

        i += 1;
    }

    return -1;
}

/**
 * A function body as a comparable string: comments and spacing dropped, each parameter replaced by `$<position>`.
 * Two copies that differ only in what they call their parameters, or in their comments, give the same string.
 * Strings and regular expression literals are kept as written: `/a b/` and `/ab/` are different predicates. Pure, and
 * the same for the same text, which is all a comparison needs.
 */
export function fingerprint(body: string, parameters: readonly string[]): string {
    const position = new Map(parameters.map((name, index) => [name, index]));
    let out = "";
    let i = 0;
    /** The word `out` ends with, else undefined: it decides whether a `/` divides or opens a regular expression. */
    let lastWord: string | undefined;
    /** For each open `(`, whether it heads an `if`, `while`, `for` or `with`. */
    const heads: boolean[] = [];
    /** True right after the `)` that closes such a head: the next `/` starts a statement, so it opens a regex. */
    let afterControlHead = false;

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
            lastWord = undefined;
            afterControlHead = false;
        } else if (WORD_START.test(char)) {
            const start = i;

            while (i < body.length && WORD.test(body[i] ?? "")) {
                i += 1;
            }

            const word = body.slice(start, i);
            const index = body[start - 1] === "." ? undefined : position.get(word);
            // A space only where two words would otherwise run together (`return value`).
            out += `${WORD.test(out[out.length - 1] ?? "") ? " " : ""}${index === undefined ? word : `$${index}`}`;
            lastWord = index === undefined ? word : `$${index}`;
            afterControlHead = false;
        } else if (/\s/.test(char)) {
            i += 1;
        } else {
            const opensRegex =
                char === "/" &&
                (afterControlHead ||
                    (lastWord !== undefined
                        ? REGEX_AFTER_WORD.has(lastWord)
                        : REGEX_AFTER_CHAR.test(out.at(-1) ?? "(")));
            const end = opensRegex ? regexLiteralEnd(body, i) : -1;

            if (char === "(") {
                heads.push(lastWord !== undefined && CONTROL_HEAD_WORDS.has(lastWord));
            }

            afterControlHead = char === ")" && heads.pop() === true;
            out += end === -1 ? char : body.slice(i, end);
            i = end === -1 ? i + 1 : end;
            lastWord = undefined;
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

function factsOf(node: SgNode, file: string, into: Inventory): void {
    const kind = node.kind();
    const line = node.range().start.line + 1;

    if (kind === "import_statement" || kind === "export_statement" || kind === "call_expression") {
        const specifier =
            kind === "call_expression" ? dynamicImportSpecifier(node) : node.field("source")?.text().slice(1, -1);
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
function langOf(file: string): Lang | null {
    if (/\.(?:tsx|jsx)$/.test(file)) {
        return Lang.Tsx;
    }

    return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(file) ? Lang.TypeScript : null;
}

export async function buildInventory(files: readonly string[]): Promise<Inventory> {
    const inventory: Inventory = { functions: [], imports: [] };
    const byLang = new Map<Lang, string[]>();

    for (const file of files) {
        const lang = langOf(file);

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
export function nearest(a: FunctionFact, b: FunctionFact): number {
    return (
        a.file.split("/").length - b.file.split("/").length ||
        a.file.length - b.file.length ||
        a.file.localeCompare(b.file)
    );
}

/** One function that copies a helper a shared folder exports: by name, by a copy's name, or by its body. */
export interface SharedCopy {
    file: string;
    line: number;
    name: string;
    how: "same-name" | "renamed" | "same-body";
    owner: { file: string; line: number; name: string };
}

/**
 * Every function outside `shared` that copies one of its exports. A name counts when it has two words (`walk` and
 * `text` are exported too and mean nothing alone); a body counts at any name. The owner is the export nearest the
 * folder's root when several files export it.
 */
export function sharedCopies(inventory: Inventory, shared: string): SharedCopy[] {
    const inShared = (file: string) => file === shared || file.startsWith(`${shared.replace(/\/$/, "")}/`);
    const byName = new Map<string, FunctionFact>();
    const byBody = new Map<string, FunctionFact>();

    for (const fact of inventory.functions) {
        if (!fact.exported || !inShared(fact.file)) {
            continue;
        }

        const named = byName.get(fact.name);
        const bodied = fact.fingerprint ? byBody.get(fact.fingerprint) : undefined;

        if (!named || nearest(fact, named) < 0) {
            byName.set(fact.name, fact);
        }

        if (fact.fingerprint && (!bodied || nearest(fact, bodied) < 0)) {
            byBody.set(fact.fingerprint, fact);
        }
    }

    const copies: SharedCopy[] = [];

    for (const fact of inventory.functions) {
        if (inShared(fact.file)) {
            continue;
        }

        const owner = (of: FunctionFact) => ({ file: of.file, line: of.line, name: of.name });
        const named = copyNames(fact.name).find((candidate) => isDistinctName(candidate) && byName.has(candidate));
        const bodied = fact.fingerprint ? byBody.get(fact.fingerprint) : undefined;
        const base = { file: fact.file, line: fact.line, name: fact.name };

        if (named) {
            const of = byName.get(named) as FunctionFact;
            copies.push({ ...base, how: named === fact.name ? "same-name" : "renamed", owner: owner(of) });
        } else if (bodied) {
            copies.push({ ...base, how: "same-body", owner: owner(bodied) });
        }
    }

    return copies;
}
