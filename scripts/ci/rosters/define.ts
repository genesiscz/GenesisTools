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

/** A call whose callee is exactly one of `names`, as `fetch(…)` or `fs.unlinkSync(…)` (the last member name). */
export function callTo(names: readonly string[]): NapiConfig {
    return {
        rule: {
            kind: "call_expression",
            has: { field: "function", regex: `(?:^|\\.)(?:${names.join("|")})$` },
        },
    };
}
