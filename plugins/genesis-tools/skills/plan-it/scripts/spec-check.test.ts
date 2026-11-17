import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSpec, rootOf } from "./spec-check.ts";

const examplePath = resolve(import.meta.dir, "../assets/spec.example.md");
const example = readFileSync(examplePath, "utf8");
const root = rootOf(examplePath);

function errorsOf(text: string): string[] {
    return checkSpec(text, { root })
        .findings.filter((f) => f.level === "error")
        .map((f) => `${f.where}: ${f.message}`);
}

function change(find: string, replace: string): string {
    expect(example.split(find).length).toBe(2);
    return example.replace(find, () => replace);
}

describe("spec-check", () => {
    test("the example spec has no error, and its packages start in the right order", () => {
        const report = checkSpec(example, { root });

        expect(report.findings).toEqual([]);
        expect(report.packages.map((p) => p.id)).toEqual(["P1", "P2", "P3"]);
        expect(report.waves).toEqual([["P1", "P2"]]);
        expect(report.waiting).toEqual([
            { id: "P3", on: ["the open decision D3", "external: the actions service (built)"] },
        ]);
    });

    test("a missing section and a missing package field are errors", () => {
        const errors = errorsOf(change("## Interface freeze", "## Names").replace("**Effort:** about one hour.\n", ""));

        expect(errors).toContain('sections: the section "## Interface freeze" is missing');
        expect(errors).toContain('P2: the field "**Effort:**" is missing or empty');
    });

    test("a need must name a package that exists, in a form the checker can read", () => {
        expect(errorsOf(change("**Needs:** P1 (interface)", "**Needs:** P7 (built)"))).toContain(
            "P2: needs P7, and no package has that id"
        );
        expect(errorsOf(change("**Needs:** P1 (interface)", "**Needs:** P1"))[0]).toContain(
            'cannot read the need "P1"'
        );
    });

    test("packages that need each other built are a circle", () => {
        const text = change("**Needs:** nothing", "**Needs:** P2 (built)").replace(
            "**Needs:** P1 (interface)",
            "**Needs:** P1 (built)"
        );

        expect(errorsOf(text).filter((e) => e.includes("form a circle")).length).toBe(2);
    });

    test("a package behind a waiting package waits too, and is no circle", () => {
        const report = checkSpec(change("**Needs:** P1 (interface)", "**Needs:** P3 (built)"), { root });

        expect(report.findings.filter((f) => f.level === "error")).toEqual([]);
        expect(report.waves).toEqual([["P1"]]);
        expect(report.waiting.at(-1)).toEqual({ id: "P2", on: ["P3 (built), which itself waits"] });
    });

    test("a target needs a source and a way, and only a tool number can be a gate", () => {
        const gate = errorsOf(change("source: tool; if not:", "source: hand-reference; gate: yes; if not:"));
        const bare = errorsOf(
            change(
                "- ideally under 300 ms for 2,000 notes; way: one read of the index, no read per note; source: tool; if not: write\n  the measured time into Progress and go on.",
                "- under 300 ms"
            )
        );

        expect(gate[0]).toContain("a number from a hand-reference cannot be a gate");
        expect(bare.length).toBe(2);
    });

    test("a path that does not exist is an error unless its line says (new)", () => {
        const errors = errorsOf(change("`.claude/rules/code.md`", "`.claude/rules/no-such-rule.md`"));

        expect(errors).toEqual([
            'Sources: the path `.claude/rules/no-such-rule.md` does not exist. Fix it, or write "(new)" on its line when the build creates it',
        ]);
        expect(checkSpec(example, { root: join(root, "plugins") }).findings.length).toBeGreaterThan(0);
        expect(checkSpec(example, { root: join(root, "plugins"), paths: false }).findings).toEqual([]);
    });

    test("a handoff a package names must be in the sources, and a placeholder is an error", () => {
        const handoff = errorsOf(change("closes t2 of `h_ab12cd34`", "closes t2 of `h_zz99yy88`"));
        const placeholder = errorsOf(change("**Effort:** about one hour.", "**Effort:** TBD"));

        expect(handoff[0]).toContain('names the handoff h_zz99yy88, and "## Sources" does not');
        expect(placeholder[0]).toContain("a placeholder (TBD)");
    });
});
