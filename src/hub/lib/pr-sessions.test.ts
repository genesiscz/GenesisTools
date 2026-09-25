import { describe, expect, it } from "bun:test";
import type { ChangeEvent } from "@app/agents/lib/changes/log";
import { branchMentions, branchNamesFromRefs } from "./branches";
import {
    checkoutOf,
    commitOutputPattern,
    commitOutputSha,
    type IndexedSession,
    matchPrSessions,
    type PrSessionsDeps,
} from "./pr-sessions";

const MAIN = "/work/app";
const WT = "/work/app-pr-12";
const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const OTHER_SHA = "1234567abcdef1234567abcdef1234567abcdef1";

function session(id: string, over: Partial<IndexedSession> = {}): IndexedSession {
    return {
        provider: "claude",
        sessionId: id,
        title: id,
        cwd: MAIN,
        project: "app",
        gitBranch: null,
        mtime: new Date("2026-09-20T10:00:00Z"),
        filePath: `/transcripts/${id}.jsonl`,
        ...over,
    };
}

function change(sessionId: string, path: string, ts = "2026-09-20T10:00:00Z"): ChangeEvent {
    return {
        ts,
        provider: "claude",
        session: sessionId,
        turn: "t",
        tool: "Edit",
        cwd: MAIN,
        path,
        beforeOid: null,
        afterOid: null,
        source: "edit",
    };
}

function deps(over: Partial<PrSessionsDeps> = {}): PrSessionsDeps {
    return {
        worktrees: async () => [
            { path: MAIN, head: "h", branch: "feat/x", isBare: false, isMain: true },
            { path: WT, head: "h", branch: "feat/x", isBare: false, isMain: false },
        ],
        changedFiles: async () => ["src/a.ts", "src/b.ts"],
        commitsBetween: async () => [HEAD_SHA],
        indexed: async () => [],
        changeLogs: () => [],
        commitOutput: async () => new Map(),
        ...over,
    };
}

const INPUT = {
    repoRoot: MAIN,
    headBranch: "feat/x",
    base: "origin/main",
    head: HEAD_SHA,
    since: new Date("2026-09-19T00:00:00Z"),
};

describe("matchPrSessions", () => {
    it("matches the head worktree, the recorded branch, commits and edited files, strongest first", async () => {
        const result = await matchPrSessions(
            INPUT,
            deps({
                indexed: async () => [
                    session("in-worktree", { cwd: `${WT}/src` }),
                    session("on-branch", { gitBranch: "feat/x" }),
                    session("committer", { gitBranch: "main" }),
                    session("editor", { gitBranch: "main" }),
                    session("unrelated", { gitBranch: "main" }),
                    session("elsewhere", { cwd: "/work/other", gitBranch: "feat/x" }),
                ],
                changeLogs: () => [change("editor", `${MAIN}/src/a.ts`), change("unrelated", `${MAIN}/README.md`)],
                commitOutput: async () => new Map([["/transcripts/committer.jsonl", new Set(["abcdef1"])]]),
            })
        );
        expect(result.sessions.map((s) => [s.sessionId, s.reasons])).toEqual([
            ["in-worktree", ["worktree"]],
            ["on-branch", ["branch"]],
            ["committer", ["commits"]],
            ["editor", ["files"]],
        ]);
        expect(result.sessions.find((s) => s.sessionId === "editor")?.files).toEqual(["src/a.ts"]);
        expect(result.sessions.find((s) => s.sessionId === "committer")?.commits).toEqual([HEAD_SHA]);
        expect(result.checkouts).toEqual([MAIN, WT]);
    });

    it("does not count every session of the main checkout because it has the head branch now", async () => {
        const result = await matchPrSessions(
            INPUT,
            deps({
                worktrees: async () => [{ path: MAIN, head: "h", branch: "feat/x", isBare: false, isMain: true }],
                indexed: async () => [session("earlier-work", { gitBranch: "main" })],
            })
        );
        expect(result.sessions).toEqual([]);
    });

    it("keeps a session the index does not know when its change log edited a PR file", async () => {
        const result = await matchPrSessions(
            INPUT,
            deps({ changeLogs: () => [change("codex-run", `${WT}/src/b.ts`)] })
        );
        expect(result.sessions).toMatchObject([{ sessionId: "codex-run", reasons: ["files"], cwd: MAIN }]);
    });

    it("ignores edits older than a day before the PR began", async () => {
        const result = await matchPrSessions(
            INPUT,
            deps({ changeLogs: () => [change("old", `${MAIN}/src/a.ts`, "2026-09-01T00:00:00Z")] })
        );
        expect(result.sessions).toEqual([]);
    });

    it("reports a failed leg as a warning and still answers from the others", async () => {
        const result = await matchPrSessions(
            INPUT,
            deps({
                changedFiles: async () => {
                    throw new Error("bad revision");
                },
                indexed: async () => [session("on-branch", { gitBranch: "feat/x" })],
            })
        );
        expect(result.warnings).toEqual(["files: Error: bad revision"]);
        expect(result.sessions.map((s) => s.sessionId)).toEqual(["on-branch"]);
    });
});

describe("commit output", () => {
    const pattern = new RegExp(commitOutputPattern([HEAD_SHA, OTHER_SHA]));

    it("reads the sha of a commit line and of a push range", () => {
        const commit = "[feat/x abcdef1] fix the thing".match(pattern)?.[0] ?? "";
        const push = "   1111111..abcdef123  feat/x -> feat/x".match(pattern)?.[0] ?? "";
        expect(commitOutputSha(commit)).toBe("abcdef1");
        expect(commitOutputSha(push)).toBe("abcdef123");
    });

    it("does not treat a log line or another sha as a commit the session made", () => {
        expect(pattern.test("abcdef1 fix the thing")).toBe(false);
        expect(pattern.test("[feat/x 7777777] other")).toBe(false);
    });

    it("finds the deepest checkout of a path", () => {
        expect(checkoutOf(`${MAIN}/wt/x.ts`, [MAIN, `${MAIN}/wt`])).toBe(`${MAIN}/wt`);
        expect(checkoutOf("/work/app-other/x.ts", [MAIN])).toBeNull();
    });
});

describe("branch mentions", () => {
    const known = branchNamesFromRefs([
        "refs/heads/feat/x",
        "refs/heads/develop",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/feat/y",
    ]);

    it("names local and remote-tracking branches without their prefix", () => {
        expect([...known].sort()).toEqual(["develop", "feat/x", "feat/y"]);
    });

    it("takes code spans and slash tokens, never plain words, fences or link targets", () => {
        const body = [
            "Stacked on `feat/y` (#12); we develop here. See feat/x.",
            "`develop` is the base. [compare](https://host/o/r/compare/feat/z)",
            "```",
            "git checkout feat/q",
            "```",
        ].join("\n");
        expect(branchMentions(body, new Set([...known, "feat/z", "feat/q"]))).toEqual(["feat/y", "develop", "feat/x"]);
    });
});
