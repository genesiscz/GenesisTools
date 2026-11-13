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
 * A string literal whose text matches `content`, in quotes or in a template: a state file's name (`/^cmux-refs\.jsonl$/`),
 * an environment variable's name, a URL path. The pattern is read by ast-grep's regex engine: keep it to plain
 * classes, anchors and alternation.
 */
export function literal(content: RegExp): NapiConfig {
    return { rule: { kind: "string_fragment", regex: content.source } };
}

/** An `import … from "<specifier>"` or `export … from "<specifier>"` whose specifier matches: a package only one module may load. */
export function importFrom(specifier: RegExp): NapiConfig {
    return {
        rule: {
            any: [{ kind: "import_statement" }, { kind: "export_statement" }],
            has: { field: "source", has: { kind: "string_fragment", regex: specifier.source } },
        },
    };
}
