import { describe, expect, test } from "bun:test";
import { subdirOf } from "@app/claude/lib/cmux/sessions";

describe("subdirOf", () => {
    test("the project root itself adds nothing", () => {
        expect(subdirOf("/Users/me/Projects/GenesisTools", "GenesisTools")).toBeNull();
    });

    test("a nested worktree shows the tail below the root", () => {
        expect(subdirOf("/Users/me/Projects/GenesisTools/.worktrees/fix", "GenesisTools")).toBe(".worktrees/fix");
    });

    /**
     * Claude Code files a SIBLING worktree (`col-fe-col-297040`, next to `col-fe`) under
     * the plain project. Without this branch several different worktrees all render as
     * `col-fe` and the picker cannot tell them apart.
     */
    test("a sibling worktree shows what distinguishes it, minus the repeated project name", () => {
        expect(subdirOf("/Users/me/Projects/CEZ/col-fe-col-297040-burn-auth", "col-fe")).toBe("col-297040-burn-auth");
    });

    test("an unrelated directory shows its own name", () => {
        expect(subdirOf("/Users/me/scratch/experiment", "col-fe")).toBe("experiment");
    });

    test("a package inside the repo keeps its full path tail", () => {
        expect(subdirOf("/Users/me/Projects/app/packages/web", "app")).toBe("packages/web");
    });
});
