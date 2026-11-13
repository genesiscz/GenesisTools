import type { NapiConfig, SgNode } from "@ast-grep/napi";

/**
 * One roster: a pattern that the architecture build (PRs #770 to #787) removed or moved into one module, and the files
 * that still hold it. `generate.ts` scans the tree with `matcher` and `test`, and writes the files and counts into
 * `rosters.json`; `lint-rules.ts` turns each definition into a rule whose per-file counts come from that manifest. A
 * file not in the roster fails the lint on its first match, and a listed file fails when its count grows, so the
 * roster only ever shrinks.
 */
export interface RosterDefinition {
    /** The lint rule name, kebab case. */
    name: string;
    /** The review candidate or fix the roster keeps from coming back (`C47`, `F7`). */
    candidate: string;
    /** What the lint prints: what to do instead, in one or two sentences. */
    message: string;
    /** The ast-grep matcher of the pattern. Keep it narrow: it runs over every file the roster covers. */
    matcher: NapiConfig;
    /** A finer check of a matched node, when the matcher alone is too wide. */
    test?: (node: SgNode) => boolean;
    /** The roster covers only these files (repo-relative path). */
    onlyIn?: RegExp;
    /** The module that owns the pattern: never a finding. */
    allowedIn?: RegExp;
}

export function defineRoster(definition: RosterDefinition): RosterDefinition {
    return definition;
}

/**
 * A call whose callee is exactly one of `names`, as `fetch(…)` or `fs.unlinkSync(…)` (the last member name), and
 * every place that binds one of them to another local name: `import { fetch as get }`, `const get = api.fetch`,
 * `const { fetch: get } = api`. The binding is the finding, so a rename at the import does not evade the roster and
 * no call has to be traced back to it (that per-call trace made a whole-tree scan take minutes).
 */
export function callTo(names: readonly string[]): NapiConfig {
    const exact = `^(?:${names.join("|")})$`;
    const member = `^[\\w$.]*\\b(?:${names.join("|")})$`;

    return {
        rule: {
            any: [
                { kind: "call_expression", has: { field: "function", regex: `(?:^|\\.)(?:${names.join("|")})$` } },
                {
                    kind: "import_specifier",
                    all: [{ has: { field: "name", regex: exact } }, { has: { field: "alias", kind: "identifier" } }],
                },
                {
                    kind: "variable_declarator",
                    all: [{ has: { field: "name", kind: "identifier" } }, { has: { field: "value", regex: member } }],
                },
                {
                    kind: "pair_pattern",
                    all: [{ has: { field: "key", regex: exact } }, { has: { field: "value", kind: "identifier" } }],
                },
            ],
        },
    };
}

/**
 * The calls a `callTo` match stands for: the call itself, or, for a binding (`import { unlink as remove }`,
 * `const remove = fs.unlinkSync`, `const { unlinkSync: remove } = fs`), every call of the bound name in its file. A
 * finer `test` that reads the call's arguments reads them through this, so a rename does not hide the call from it.
 * Only a binding (rare) walks its file, so a whole-tree scan stays one pass.
 */
export function callsOf(node: SgNode): SgNode[] {
    if (node.kind() === "call_expression") {
        return [node];
    }

    const bound =
        node.kind() === "import_specifier"
            ? node.field("alias")
            : node.kind() === "variable_declarator"
              ? node.field("name")
              : node.field("value");
    const name = bound?.text();
    if (!name || !/^[\w$]+$/.test(name)) {
        return [];
    }

    return node
        .getRoot()
        .root()
        .findAll({
            rule: { kind: "call_expression", has: { field: "function", regex: `^${name.replace(/\$/g, "\\$")}$` } },
        });
}

/**
 * A string literal whose text matches `content`, in quotes or in a template: a state file's name (`/^cmux-refs\.jsonl$/`),
 * an environment variable's name, a URL path. The pattern is read by ast-grep's regex engine: keep it to plain
 * classes, anchors and alternation.
 */
export function literal(content: RegExp): NapiConfig {
    return { rule: { kind: "string_fragment", regex: content.source } };
}

/**
 * An `import … from "<specifier>"`, an `export … from "<specifier>"` or an `import("<specifier>")` whose specifier
 * matches: a package only one module may load.
 */
export function importFrom(specifier: RegExp): NapiConfig {
    const text = { kind: "string_fragment", regex: specifier.source };

    return {
        rule: {
            any: [
                {
                    any: [{ kind: "import_statement" }, { kind: "export_statement" }],
                    has: { field: "source", has: text },
                },
                {
                    kind: "call_expression",
                    all: [
                        { has: { field: "function", kind: "import" } },
                        { has: { field: "arguments", has: { kind: "string", has: text } } },
                    ],
                },
            ],
        },
    };
}

/** Wrappers that leave a value as it is: `[…] as const`, `[…] satisfies string[]`, `([…])`, `x!`. */
const SAME_VALUE = new Set([
    "as_expression",
    "satisfies_expression",
    "parenthesized_expression",
    "non_null_expression",
]);

/** Where an argv array is kept before a call takes it: `const args = […]`, `{ args: […] }`, `args = […]`. */
const ARGV_HOLDERS = new Set(["variable_declarator", "pair", "assignment_expression"]);

/** The name a holder keeps its array under: the variable, the object key, or the assigned name. */
const HOLDER_NAME: Record<string, string> = {
    variable_declarator: "name",
    pair: "key",
    assignment_expression: "left",
};

/** Wrappers between a kept argv's name and the call that takes it: `run(step.args)`, `run([...BASE, "x"])`. */
const ARGV_PATH = new Set([...SAME_VALUE, "member_expression", "subscript_expression", "spread_element", "array"]);

/**
 * Runners that take any program's argv, named by their verb only (`run(TREE_ARGS)` with `run` injected for tests):
 * the program is the one the file runs. A runner named for a program (`runAx`) or any other call (`z.enum`) is not.
 */
const GENERIC_RUNNER = /^(?:run|runner|exec|execSync|execFile|execFileSync|spawn|spawnSync)$/;

/** The name a call is made through: `run` for `run(…)`, `run` for `options.run!(…)`, `enum` for `z.enum(…)`. */
function invokedName(call: SgNode): string {
    let callee = call.field("function");

    while (callee && SAME_VALUE.has(String(callee.kind()))) {
        callee = callee.children().find((child) => child.isNamed()) ?? null;
    }

    if (callee?.kind() === "member_expression") {
        return callee.field("property")?.text() ?? "";
    }

    return callee?.text() ?? "";
}

/** The call whose arguments hold `node`, through the wrappers of `ARGV_PATH`, or null when something else takes it. */
function consumingCall(node: SgNode): SgNode | null {
    let current: SgNode | null = node.parent();

    while (current && ARGV_PATH.has(String(current.kind()))) {
        current = current.parent();
    }

    return current?.kind() === "arguments" ? (current.parent() ?? null) : null;
}

/** The calls that take the array kept under `holder`'s name, found by that name in the holder's file. */
function keptArgvCalls(holder: SgNode): SgNode[] {
    const name = holder.field(HOLDER_NAME[String(holder.kind())] ?? "name")?.text() ?? "";

    if (!/^[\w$]+$/.test(name)) {
        return [];
    }

    const uses = holder
        .getRoot()
        .root()
        .findAll({
            rule: {
                any: [{ kind: "identifier" }, { kind: "property_identifier" }],
                regex: `^${name.replace(/\$/g, "\\$")}$`,
            },
        });

    return uses.flatMap((use) => {
        const call = consumingCall(use);
        return call ? [call] : [];
    });
}

/**
 * Whether an argv array goes to the program whose runner's name matches `program` (`/cmux/i` for `runCmuxOk`): passed
 * straight to such a call, or kept first in a variable or an object whose name then reaches such a call, or reaches a
 * runner named by its verb only (`run(TREE_ARGS)`) in a file that calls a runner of the program or imports a module
 * whose path names it. The kept form is how an owner holds its argv (`const TREE_ARGS = […]` and `run(TREE_ARGS)`), so
 * a copy of the owner is a finding too; an array kept for another consumer (`z.enum(verbs)`, `runAx(AX_ARGS)`) is not,
 * even in a file that runs the program. Use it as a definition's `test`.
 */
export function argvFor(node: SgNode, program: RegExp): boolean {
    let holder = node.parent();

    while (holder && SAME_VALUE.has(String(holder.kind()))) {
        holder = holder.parent();
    }

    if (!holder) {
        return false;
    }

    if (holder.kind() === "arguments") {
        return program.test(holder.parent()?.field("function")?.text() ?? "");
    }

    if (!ARGV_HOLDERS.has(String(holder.kind()))) {
        return false;
    }

    const consumers = keptArgvCalls(holder);

    if (consumers.some((call) => program.test(call.field("function")?.text() ?? ""))) {
        return true;
    }

    if (!consumers.some((call) => GENERIC_RUNNER.test(invokedName(call)))) {
        return false;
    }

    const regex = `${program.flags.includes("i") ? "(?i)" : ""}${program.source}`;
    const runner = node
        .getRoot()
        .root()
        .find({
            rule: {
                any: [
                    { kind: "call_expression", has: { field: "function", regex } },
                    { kind: "import_statement", has: { field: "source", regex } },
                ],
            },
        });

    return runner !== null;
}

/**
 * A function, class, `const` or method declared under a name that matches: the forms the `shadowed` refactor analyser
 * reports as a private copy of a shared helper. TypeScript grammars only: JavaScript has no
 * `abstract_class_declaration`, and ast-grep refuses the whole rule for a `.js` file, which aborts the roster run. A
 * definition that uses it keeps `onlyIn` to `.ts`, `.tsx` and their kin, as the scaffold writes it.
 */
export function declaration(name: RegExp): NapiConfig {
    const named = { field: "name", regex: name.source };

    return {
        rule: {
            any: [
                "function_declaration",
                "generator_function_declaration",
                "class_declaration",
                "abstract_class_declaration",
                "variable_declarator",
                "method_definition",
            ].map((kind) => ({ kind, has: named })),
        },
    };
}
