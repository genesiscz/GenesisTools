import { describe, expect, test } from "bun:test";
import { basePresetExamples, WorktreeNotConfiguredError, worktreeDirName, worktreePolicy } from "./policy";

describe("worktreePolicy", () => {
    test("refuses an unconfigured repo instead of guessing a base directory", () => {
        expect(() => worktreePolicy({}, "/repo")).toThrow(WorktreeNotConfiguredError);
        expect(() => worktreePolicy({ git: {} }, "/repo")).toThrow(WorktreeNotConfiguredError);
        expect(() => worktreePolicy({ git: { worktrees: {} } }, "/repo")).toThrow(WorktreeNotConfiguredError);
        expect(() => worktreePolicy({ git: { worktrees: { base: "   " } } }, "/repo")).toThrow(
            WorktreeNotConfiguredError
        );
    });

    test("resolves a relative base against the repo root and keeps an absolute one", () => {
        expect(worktreePolicy({ git: { worktrees: { base: ".claude/worktrees" } } }, "/repo").baseDir).toBe(
            "/repo/.claude/worktrees"
        );
        expect(worktreePolicy({ git: { worktrees: { base: "../" } } }, "/repo/sub").baseDir).toBe("/repo");
        expect(worktreePolicy({ git: { worktrees: { base: "/elsewhere/wt" } } }, "/repo").baseDir).toBe(
            "/elsewhere/wt"
        );
    });

    test("install is null when omitted or blank, so a caller cannot run an empty command", () => {
        expect(worktreePolicy({ git: { worktrees: { base: ".worktrees" } } }, "/repo").install).toBeNull();
        expect(
            worktreePolicy({ git: { worktrees: { base: ".worktrees", install: "  " } } }, "/repo").install
        ).toBeNull();
        expect(
            worktreePolicy({ git: { worktrees: { base: ".worktrees", install: " bun install " } } }, "/repo").install
        ).toBe("bun install");
    });

    test("plansSync defaults off, so a repo opts into copying plans around", () => {
        expect(worktreePolicy({ git: { worktrees: { base: ".worktrees" } } }, "/repo").plansSync).toBe(false);
        expect(worktreePolicy({ git: { worktrees: { base: ".w", plansSync: true } } }, "/repo").plansSync).toBe(true);
    });
});

describe("worktreeDirName", () => {
    test("flattens slashes so a branch cannot create nested directories", () => {
        expect(worktreeDirName("feat/login")).toBe("feat-login");
        expect(worktreeDirName("refs/heads/feat/login")).toBe("feat-login");
        expect(worktreeDirName("release/2026-01-01")).toBe("release-2026-01-01");
    });

    test("collapses runs and trims separators", () => {
        expect(worktreeDirName("feat//weird**name")).toBe("feat-weird-name");
        expect(worktreeDirName("/leading/")).toBe("leading");
    });
});

describe("basePresetExamples", () => {
    test("every preset shows the concrete directory it would produce", () => {
        const examples = basePresetExamples("/repo", "feat/login");
        expect(examples.map((e) => e.example)).toEqual([
            "/repo/.claude/worktrees/feat-login",
            "/repo/.worktrees/feat-login",
            "/feat-login",
        ]);
    });
});
