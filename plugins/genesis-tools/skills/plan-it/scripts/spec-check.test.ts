import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSpec, main, rootOf } from "./spec-check.ts";

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
        const text = change("**Needs:** P2 (interface)", "**Needs:** P2 (built)").replace(
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
        expect(bare.length).toBe(3);
        expect(bare.some((e) => e.includes('needs "source:"'))).toBe(true);
        expect(bare.some((e) => e.includes('needs "way:"'))).toBe(true);
        expect(bare.some((e) => e.includes('needs "if not:"'))).toBe(true);
    });

    test("a target with only one of way and if not, or an empty label, is an error", () => {
        const target = (rest: string) =>
            errorsOf(
                change(
                    "way: one read of the index, no read per note; source: tool; if not: write\n  the measured time into Progress and go on.",
                    rest
                )
            );

        expect(target("source: tool; if not: write it down")).toEqual([expect.stringContaining('needs "way:"')]);
        expect(target("way: one read; source: tool")).toEqual([expect.stringContaining('needs "if not:"')]);
        expect(target("way:; source: tool; if not: write it down")).toEqual([expect.stringContaining('needs "way:"')]);
        expect(target("way: one read; source: tool; if not:")).toEqual([expect.stringContaining('needs "if not:"')]);
    });

    test("a Needs field that wraps onto a second line is read whole", () => {
        const report = checkSpec(
            change(
                "**Needs:** P1 (built), external: the actions service (built)",
                "**Needs:** P1 (built),\nexternal: the actions service (built)"
            ),
            { root }
        );

        expect(report.findings).toEqual([]);
        expect(report.waiting.at(-1)?.on).toContain("external: the actions service (built)");
    });

    test("a package id defined twice is an error", () => {
        const errors = errorsOf(change("### P2: private notes", "### P1: private notes"));

        expect(errors.some((e) => e.includes("the package id P1 is already defined"))).toBe(true);
    });

    test("a package behind a circle is named as blocked, not as a member", () => {
        const text = change("**Needs:** P2 (interface)", "**Needs:** P2 (built)")
            .replace("**Needs:** P1 (interface)", "**Needs:** P1 (built)")
            .replace("**Needs:** P1 (built), external: the actions service (built)", "**Needs:** P2 (built)")
            .replace("blocks P3", "blocks nothing");
        const errors = errorsOf(text);

        expect(errors.filter((e) => e.includes("form a circle")).length).toBe(2);
        expect(errors.some((e) => e.startsWith("P3:") && e.includes("waits on a circle it is not part of"))).toBe(true);
    });

    test("a blank header value, a longer handoff id and an unknown blocked package are errors", () => {
        expect(
            errorsOf(
                change(
                    "**Status:** 2026-11-17 19:40, ready for an executor. One decision is open (D3).",
                    "**Status:**   "
                )
            ).some((e) => e.includes('"**Status:**"'))
        ).toBe(true);
        expect(
            errorsOf(
                example.replace(/(## Sources[\s\S]*?)## Interface freeze/, (m) =>
                    m.replaceAll("h_ab12cd34", "h_ab12cd345")
                )
            )[0]
        ).toContain("names the handoff h_ab12cd34,");
        expect(errorsOf(change("blocks P3", "blocks P33"))).toContain("D3: blocks P33, and no package has that id");
    });

    test("a shorter fence inside a longer fence does not close it", () => {
        const text = `${example}\n## Extra\n\n\`\`\`\`md\n\`\`\`\nTODO\n\`\`\`\`\n`;

        expect(errorsOf(text).some((e) => e.includes("a placeholder"))).toBe(false);
    });

    test("a flag with no value is a usage error", () => {
        expect(main([examplePath, "--max-lines"])).toBe(2);
        expect(main([examplePath, "--root"])).toBe(2);
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
