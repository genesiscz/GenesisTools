import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeDelta, worktreeState } from "./worktree";

const scratch = (): string => mkdtempSync(join(tmpdir(), "grok-worktree-test-"));

const gitInit = (dir: string): void => {
    Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: dir, stdout: "ignore", stderr: "ignore" });
};

describe("worktreeDelta", () => {
    test("reports nothing changed when both snapshots match", () => {
        const before = [" M src/a.ts"];
        expect(worktreeDelta(before, [" M src/a.ts"])).toEqual({ changedThisTurn: 0, dirtyTotal: 1 });
    });

    test("counts only entries the turn introduced", () => {
        const before = [" M src/a.ts"];
        const after = [" M src/a.ts", " M src/b.ts", "?? src/c.ts"];
        expect(worktreeDelta(before, after)).toEqual({ changedThisTurn: 2, dirtyTotal: 3 });
    });

    test("a clean tree that stays clean is zero, not null", () => {
        expect(worktreeDelta([], [])).toEqual({ changedThisTurn: 0, dirtyTotal: 0 });
    });

    test("is null when either snapshot is unknown", () => {
        expect(worktreeDelta(null, [])).toBeNull();
        expect(worktreeDelta([], null)).toBeNull();
    });
});

describe("worktreeState", () => {
    test("returns null outside a git repo rather than throwing", () => {
        expect(worktreeState(scratch())).toBeNull();
    });

    test("returns null for a directory that does not exist", () => {
        expect(worktreeState(join(tmpdir(), "grok-worktree-absent-does-not-exist"))).toBeNull();
    });

    test("reports a clean repo as an empty list, which is not null", () => {
        const dir = scratch();
        gitInit(dir);
        expect(worktreeState(dir)).toEqual([]);
    });

    test("sees an untracked file appear, and the delta counts it once", () => {
        const dir = scratch();
        gitInit(dir);
        const before = worktreeState(dir);
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "new.ts"), "export const x = 1;\n");
        const after = worktreeState(dir);

        expect(after?.length).toBe(1);
        expect(worktreeDelta(before, after)).toEqual({ changedThisTurn: 1, dirtyTotal: 1 });
    });

    test("a turn that writes nothing produces a zero delta", () => {
        const dir = scratch();
        gitInit(dir);
        writeFileSync(join(dir, "already-dirty.ts"), "export const x = 1;\n");
        const before = worktreeState(dir);
        const after = worktreeState(dir);

        expect(worktreeDelta(before, after)).toEqual({ changedThisTurn: 0, dirtyTotal: 1 });
    });
});
