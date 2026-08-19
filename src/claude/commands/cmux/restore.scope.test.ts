import { describe, expect, test } from "bun:test";
import { type RestoreOptions, resolveScope } from "@app/claude/commands/cmux/restore";

/**
 * Only the non-interactive paths are asserted here. Each one must resolve WITHOUT a
 * prompt: a run that stops to ask inside `-y`, a snapshot replay, or a pipe would hang
 * forever with nothing on screen to explain why.
 */
function options(overrides: Partial<RestoreOptions> = {}): RestoreOptions {
    return {
        last: "12",
        layout: "capped",
        perWorkspace: "4",
        perProject: true,
        enter: true,
        ...overrides,
    };
}

describe("resolveScope", () => {
    test("--this-project wins without asking", async () => {
        expect(await resolveScope(options({ thisProject: true }), false)).toBe("this");
    });

    test("--all-projects wins without asking", async () => {
        expect(await resolveScope(options({ allProjects: true }), false)).toBe("all");
    });

    test("--this-project beats --all-projects when both are passed", async () => {
        expect(await resolveScope(options({ thisProject: true, allProjects: true }), false)).toBe("this");
    });

    test("a snapshot replay never asks — the snapshot already names its sessions", async () => {
        expect(await resolveScope(options(), true)).toBe("all");
    });

    test("-y never asks and takes every project", async () => {
        expect(await resolveScope(options({ yes: true }), false)).toBe("all");
    });

    test("-y with --this-project still honours the flag", async () => {
        expect(await resolveScope(options({ yes: true, thisProject: true }), false)).toBe("this");
    });
});
