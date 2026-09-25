import { describe, expect, test } from "bun:test";
import type { CheckLogResult } from "./checks";
import { type FixCheckDeps, fixCheck } from "./checks-fix";
import {
    type FixThreadsDeps,
    fixThreads,
    fixThreadsMarkdown,
    fixThreadsPrompt,
    noPaneMatched,
    rankOwners,
    selectThreads,
} from "./fix-threads";
import type { FoundPr, PrThread } from "./pr";
import type { PrSessionMatch } from "./pr-sessions";

const pr: FoundPr = {
    provider: "github",
    host: "github.com",
    project: "acme/web",
    number: 42,
    url: "https://github.com/acme/web/pull/42",
    webUrl: "https://github.com/acme/web/pull/42",
    title: "Faster checkout",
    state: "OPEN",
    draft: false,
    author: "alice",
    sourceBranch: "feat/checkout",
    targetBranch: "main",
    headSha: "h1",
    baseSha: "b1",
    crossRepository: false,
    headRepo: null,
    repoPath: null,
};

function thread(id: string, over: Partial<PrThread> = {}): PrThread {
    return {
        id,
        path: "src/cart.ts",
        side: "additions",
        line: 10,
        outdated: false,
        resolved: false,
        resolvable: true,
        comments: [
            {
                id: `${id}-c1`,
                author: { name: "Bob Reviewer", username: "bob" },
                bodyMarkdown: "Use the shared helper here.\n\nIt already rounds.",
                createdAt: "2026-09-20T10:00:00Z",
                isDraft: false,
            },
        ],
        ...over,
    };
}

function match(sessionId: string, reasons: PrSessionMatch["reasons"], mtime: string): PrSessionMatch {
    return {
        provider: "claude",
        sessionId,
        title: `session ${sessionId}`,
        cwd: "/work/web",
        project: "web",
        gitBranch: "feat/checkout",
        mtime,
        reasons,
        files: [],
        fileCount: 0,
        commits: [],
    };
}

interface Calls {
    sent: Array<[string, string]>;
    focused: Array<[string, boolean]>;
    written: string[];
    searched: number;
}

function deps(over: Partial<FixThreadsDeps> = {}): { deps: FixThreadsDeps; calls: Calls } {
    const calls: Calls = { sent: [], focused: [], written: [], searched: 0 };
    return {
        calls,
        deps: {
            pr: async () => pr,
            threads: async () => ({
                pr,
                threads: [thread("T1"), thread("T2", { path: "src/pay.ts", line: 4, startLine: 2 }), thread("T3")],
                draftCount: 0,
                viewer: "alice",
                cached: false,
                fetchedAt: "2026-09-24T10:00:00Z",
            }),
            sessions: async () => {
                calls.searched++;
                return [
                    match("aaaaaaaa-old", ["files"], "2026-09-24T09:00:00Z"),
                    match("bbbbbbbb-own", ["worktree"], "2026-09-23T09:00:00Z"),
                ];
            },
            live: async (ids) => new Set(ids.filter((id) => id.startsWith("bbbbbbbb"))),
            write: async (file) => {
                calls.written.push(file);
            },
            send: async (sessionId, text) => {
                calls.sent.push([sessionId, text]);
                return null;
            },
            focus: async (sessionId, activate) => {
                calls.focused.push([sessionId, activate]);
                return null;
            },
            dir: "/tmp/fix",
            now: () => new Date("2026-09-24T12:00:00Z"),
            ...over,
        },
    };
}

describe("fix threads: pure parts", () => {
    test("selectThreads keeps the PR's order and names the ids it does not have", () => {
        const { selected, missing } = selectThreads([thread("T1"), thread("T2"), thread("T3")], ["T3", "gone", "T1"]);
        expect(selected.map((t) => t.id)).toEqual(["T1", "T3"]);
        expect(missing).toEqual(["gone"]);
    });

    test("the task file carries each thread's place, notes and id, and says not to write to the PR", () => {
        const text = fixThreadsMarkdown({
            pr,
            threads: [thread("T2", { line: 4, startLine: 2, resolved: true })],
            repo: "/work/web",
        });
        expect(text).toContain("# Fix 1 review thread on #42: Faster checkout");
        expect(text).toContain("## 1. `src/cart.ts:2-4` (resolved)");
        expect(text).toContain("Thread id: `T2`");
        expect(text).toContain("**@bob**, 2026-09-20T10:00:00Z:");
        expect(text).toContain("> Use the shared helper here.\n>\n> It already rounds.");
        expect(text).toContain("Do not reply on the PR, resolve threads, or submit a review");
    });

    test("the prompt is one line that names the file, never the thread text", () => {
        const prompt = fixThreadsPrompt({ file: "/tmp/fix/a.md", count: 3, label: "!7" });
        expect(prompt).toBe(
            "Fix the 3 review threads of !7 listed in /tmp/fix/a.md: read that file and change the code for each one."
        );
        expect(prompt).not.toContain("\n");
    });

    test("owners rank live first, then worktree/branch over files, then newest", () => {
        const ranked = rankOwners(
            [
                match("files-new", ["files"], "2026-09-24T11:00:00Z"),
                match("branch-old", ["branch"], "2026-09-20T11:00:00Z"),
                match("branch-new", ["branch", "files"], "2026-09-22T11:00:00Z"),
                match("live-files", ["files"], "2026-09-01T11:00:00Z"),
            ],
            new Set(["live-files"])
        );
        expect(ranked.map((owner) => owner.sessionId)).toEqual(["live-files", "branch-new", "branch-old", "files-new"]);
        expect(ranked[0].live).toBe(true);
        expect(ranked[1].live).toBe(false);
    });

    test("noPaneMatched reads the verb's empty-match JSON only", () => {
        expect(noPaneMatched('{"query":"x","sent":false,"matches":[]}')).toBe(true);
        expect(noPaneMatched('{"matches":[{"paneId":"p"}]}')).toBe(false);
        expect(noPaneMatched("not json")).toBe(false);
    });
});

describe("fixThreads", () => {
    test("sends one line to the live owner, then focuses its pane", async () => {
        const { deps: d, calls } = deps();
        const result = await fixThreads({ repo: "/work/web", ids: ["T2", "T1"] }, d);
        expect(result.owner?.sessionId).toBe("bbbbbbbb-own");
        expect(result.threads.map((t) => t.id)).toEqual(["T1", "T2"]);
        expect(calls.written).toEqual(["/tmp/fix/acme_web-42-2026-09-24T12-00-00-000Z.md"]);
        expect(calls.sent).toEqual([["bbbbbbbb-own", result.prompt]]);
        expect(result.prompt).toContain(calls.written[0]);
        expect(calls.focused).toEqual([["bbbbbbbb-own", true]]);
        expect(result).toMatchObject({ sent: true, focused: true, written: true, error: null });
    });

    test("a dry run plans with candidates and writes, sends and focuses nothing", async () => {
        const { deps: d, calls } = deps();
        const result = await fixThreads({ repo: "/work/web", ids: ["T1"], dryRun: true }, d);
        expect(result.candidates.map((c) => c.sessionId)).toEqual(["bbbbbbbb-own", "aaaaaaaa-old"]);
        expect(result).toMatchObject({ written: false, sent: false, focused: false });
        expect(calls).toEqual({ sent: [], focused: [], written: [], searched: 1 });
    });

    test("an explicit session skips the search and gets the send even when not live", async () => {
        const { deps: d, calls } = deps();
        const result = await fixThreads(
            { repo: "/work/web", ids: ["T1"], session: "cccccccc-new", activate: false },
            d
        );
        expect(calls.searched).toBe(0);
        expect(calls.sent.map(([id]) => id)).toEqual(["cccccccc-new"]);
        expect(calls.focused).toEqual([["cccccccc-new", false]]);
        expect(result.owner).toMatchObject({ sessionId: "cccccccc-new", live: false });
    });

    test("no live owner: the file is written but nothing is typed anywhere", async () => {
        const { deps: d, calls } = deps({ live: async () => new Set() });
        const result = await fixThreads({ repo: "/work/web", ids: ["T1"] }, d);
        expect(calls.written.length).toBe(1);
        expect(calls.sent).toEqual([]);
        expect(calls.focused).toEqual([]);
        expect(result.error).toContain("no session that owns feat/checkout is open in cmux");
    });

    test("--no-send writes the file for a new agent and neither searches nor sends", async () => {
        const { deps: d, calls } = deps();
        const result = await fixThreads({ repo: "/work/web", ids: ["T1"], send: false }, d);
        expect(result.written).toBe(true);
        expect(calls.searched).toBe(0);
        expect(calls.sent).toEqual([]);
    });

    test("a failed send does not focus, and a failed focus keeps the send", async () => {
        const failedSend = deps({ send: async () => "no cmux pane runs this session" });
        const sendResult = await fixThreads({ repo: "/work/web", ids: ["T1"] }, failedSend.deps);
        expect(sendResult).toMatchObject({ sent: false, focused: false });
        expect(sendResult.error).toContain("no cmux pane runs this session");
        expect(failedSend.calls.focused).toEqual([]);

        const failedFocus = deps({ focus: async () => "cmux is not reachable" });
        const focusResult = await fixThreads({ repo: "/work/web", ids: ["T1"] }, failedFocus.deps);
        expect(focusResult).toMatchObject({ sent: true, focused: false });
        expect(focusResult.error).toContain("the focus failed");
    });

    test("ids the PR does not have fail before anything is written", async () => {
        const { deps: d, calls } = deps();
        await expect(fixThreads({ repo: "/work/web", ids: ["gone"] }, d)).rejects.toThrow(
            "has none of the threads gone"
        );
        await expect(fixThreads({ repo: "/work/web", ids: [] }, d)).rejects.toThrow("at least one thread id");
        expect(calls.written).toEqual([]);
    });
});

describe("fix check", () => {
    const emptyLog: CheckLogResult = {
        url: "https://github.com/o/r/actions/runs/1/job/2",
        provider: "github",
        sections: [],
        errors: [],
        final: true,
        cached: false,
        fetchedAt: "2026-09-24T10:00:00Z",
        elapsedMs: 3,
        error: null,
    };

    function checkDeps(over: Partial<FixThreadsDeps> = {}): { deps: FixCheckDeps; order: string[] } {
        const order: string[] = [];
        const base = deps({
            pr: async () => {
                order.push("pr");
                return pr;
            },
            ...over,
        }).deps;
        return {
            order,
            deps: {
                ...base,
                log: async () => {
                    order.push("log");
                    return emptyLog;
                },
            },
        };
    }

    test("the PR is resolved before the log is fetched, so a ref the host does not know costs no log request", async () => {
        const { deps: d, order } = checkDeps({
            pr: async () => {
                order.push("pr");
                throw new Error("/work/web#42 is not a GitHub PR or GitLab MR");
            },
        });
        await expect(
            fixCheck(
                { repo: "/work/web", pr: "/work/web#42", checkUrl: emptyLog.url, checkName: "ci", dryRun: true },
                d
            )
        ).rejects.toThrow("not a GitHub PR");
        expect(order).toEqual(["pr"]);
    });

    test("a dry run reads the PR, then the log, and plans the task with no threads", async () => {
        const { deps: d, order } = checkDeps();
        const result = await fixCheck(
            { repo: "/work/web", pr: "/work/web#42", checkUrl: emptyLog.url, checkName: "ci", dryRun: true },
            d
        );
        expect(order).toEqual(["pr", "log"]);
        expect(result).toMatchObject({ threads: [], missing: [], written: false, sent: false });
        expect(result.prompt).toContain("ci");
    });
});
