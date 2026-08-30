import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@genesiscz/utils/string";
import { formatQaEntry } from "./format";
import type { QaEntry } from "./types";
import { worktreeLabel } from "./worktree-label";

const base: QaEntry = {
    id: "e1",
    ts: 1779000000000,
    sessionId: "0123456789abcdef",
    sessionTitle: null,
    project: "MainRepo",
    repoRoot: "/r",
    cwd: "/r",
    branch: "feat/x",
    commitSha: "abc1234",
    commitMessage: null,
    agent: "unknown",
    isWorktree: false,
    worktreePath: null,
    aiAgent: null,
    agentLabel: null,
    tag: "question",
    question: "why X?",
    answerMd: "Because Y.",
    refs: [],
    source: "mcp",
    turnUuid: null,
};

describe("formatQaEntry", () => {
    it("shows project and branch for a main checkout", () => {
        const out = stripAnsi(formatQaEntry(base));
        expect(out).toContain("MainRepo · feat/x");
        expect(out).not.toContain("worktree");
    });

    it("names the worktree, so two checkouts of one repo are told apart", () => {
        const out = stripAnsi(formatQaEntry({ ...base, isWorktree: true, worktreePath: "/r/.worktrees/feat-x-202" }));
        expect(out).toContain("MainRepo · feat/x (worktree feat-x-202)");
    });

    it("worktreeLabel is null unless both flags agree", () => {
        expect(worktreeLabel({ isWorktree: false, worktreePath: "/r/.worktrees/x" })).toBeNull();
        expect(worktreeLabel({ isWorktree: true, worktreePath: null })).toBeNull();
        expect(worktreeLabel({ isWorktree: true, worktreePath: "/r/.worktrees/x" })).toBe("x");
    });
});
