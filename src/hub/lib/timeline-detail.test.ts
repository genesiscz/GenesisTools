import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "@app/question/lib/decisions/store";
import type { ResolvedTranscript, TranscriptTurn } from "@genesiscz/utils/ai/transcripts";
import type { SessionSubagent } from "@genesiscz/utils/ai/transcripts/subagents";
import { env } from "@genesiscz/utils/env";
import type { ComputedSessionChanges } from "@genesiscz/utils/session-changes";
import { Storage } from "@genesiscz/utils/storage";
import type { ThreadsResult } from "./pr";
import type { HubPr, HubPrDetail } from "./prs";
import { git } from "./timeline";
import {
    type CommitDetail,
    type PrEventDetail,
    type PushDetail,
    type SessionDetail,
    type ThreadDetail,
    type TimelineDetailDeps,
    TimelineDetailError,
    timelineDetail,
} from "./timeline-detail";

const NOW = new Date("2026-03-02T15:00:00");
const SINCE = new Date("2026-03-02T00:00:00");
const iso = (clock: string) => new Date(`2026-03-02T${clock}`).toISOString();

/** A scratch repository: two commits on main, a feature branch on top, a remote-looking ref. */
interface Scratch {
    root: string;
    first: string;
    second: string;
}

async function scratchRepo(): Promise<Scratch> {
    const root = mkdtempSync(join(tmpdir(), "gt-timeline-detail-"));
    const run = (args: string[]) => git(args, root);
    await run(["init", "-q", "-b", "main"]);
    await run(["config", "user.email", "alice@example.com"]);
    await run(["config", "user.name", "Alice"]);
    await run(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(root, "parse.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(root, "README.md"), "# app\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "feat: parser"]);
    const first = (await run(["rev-parse", "HEAD"])).trim();
    await run(["checkout", "-q", "-b", "feat/parser"]);
    writeFileSync(join(root, "parse.ts"), "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n");
    await run(["add", "."]);
    await run(["commit", "-q", "-m", "fix: cache\n\nThe cache key forgot the branch."]);
    const second = (await run(["rev-parse", "HEAD"])).trim();
    await run(["update-ref", "refs/remotes/origin/feat/parser", second]);
    return { root, first, second };
}

async function scratchStorage(): Promise<Storage> {
    const home = mkdtempSync(`${tmpdir()}/gt-timeline-detail-home-`);
    let storage: Storage | undefined;
    await env.testing.withOverrides({ GENESIS_TOOLS_HOME: home }, () => {
        storage = new Storage("hub");
    });

    if (!storage) {
        throw new Error("no scratch storage");
    }

    return storage;
}

function pr(root: string): HubPr {
    return {
        number: 7,
        title: "Parser rewrite",
        state: "OPEN",
        draft: false,
        author: "alice",
        headBranch: "feat/parser",
        baseBranch: "main",
        url: "https://github.com/acme/app/pull/7",
        createdAt: iso("10:10:00"),
        updatedAt: iso("12:00:00"),
        labels: [],
        reviewers: [],
        reviewDecision: "APPROVED",
        approvals: 1,
        ci: "failed",
        comments: null,
        headSha: null,
        crossRepository: false,
        headRepo: null,
        repo: "app",
        repoRoot: root,
        origin: { kind: "github", host: "github.com", web: "https://github.com/acme/app" },
        localWorktree: null,
        isMine: true,
        proposal: null,
    };
}

function prDetail(root: string): HubPrDetail {
    return {
        ...pr(root),
        body: "Rewrites the parser.",
        commits: [],
        changedFiles: 2,
        additions: 10,
        deletions: 3,
        baseSha: null,
        mergeable: "mergeable",
        mergeStatus: null,
        checks: [
            { name: "CI / test", status: "failed", url: "https://github.com/acme/app/actions/runs/1" },
            { name: "CI / lint", status: "success", url: null },
        ],
        webUrls: {
            pr: "https://github.com/acme/app/pull/7",
            files: "https://github.com/acme/app/pull/7/files",
            commits: "https://github.com/acme/app/pull/7/commits",
            checks: "https://github.com/acme/app/pull/7/checks",
        },
        warnings: [],
        branchMentions: [],
    };
}

function threads(root: string): ThreadsResult {
    return {
        pr: {
            provider: "github",
            host: "github.com",
            project: "acme/app",
            number: 7,
            url: "https://github.com/acme/app/pull/7",
            webUrl: "https://github.com/acme/app/pull/7",
            title: "Parser rewrite",
            state: "OPEN",
            draft: false,
            author: "alice",
            sourceBranch: "feat/parser",
            targetBranch: "main",
            headSha: null,
            baseSha: null,
            crossRepository: false,
            headRepo: null,
            repoPath: root,
        },
        threads: [
            {
                id: "t1",
                path: "parse.ts",
                side: "additions",
                line: 2,
                outdated: false,
                resolved: false,
                resolvable: true,
                comments: [
                    {
                        id: "c-old",
                        author: { name: "Bob", username: "bob" },
                        bodyMarkdown: "old",
                        createdAt: "2026-03-01T12:00:00.000Z",
                        isDraft: false,
                    },
                    {
                        id: "c-today",
                        author: { name: "Bob", username: "bob" },
                        bodyMarkdown: "🧹 Quality | Medium\n\n**Guard the empty input**\n\nmore",
                        createdAt: iso("12:30:00"),
                        isDraft: false,
                    },
                ],
            },
            {
                id: "t2",
                path: "README.md",
                side: "additions",
                line: 1,
                outdated: false,
                resolved: true,
                resolvable: true,
                comments: [
                    {
                        id: "c-done",
                        author: { name: "Alice", username: "alice" },
                        bodyMarkdown: "done",
                        createdAt: iso("13:00:00"),
                        isDraft: false,
                    },
                ],
            },
        ],
        draftCount: 0,
        viewer: "alice",
        cached: true,
        fetchedAt: iso("13:01:00"),
    };
}

function turn(role: TranscriptTurn["role"], clock: string, text: string): TranscriptTurn {
    return { id: `${role}-${clock}`, role, at: iso(clock), text, tools: [] };
}

const RESOLVED: ResolvedTranscript = {
    provider: "claude",
    source: "native",
    sessionId: "s-alpha",
    filePath: "/tmp/gt-timeline-detail/s-alpha.jsonl",
};

const TURNS: TranscriptTurn[] = [
    turn("user", "08:00:00", "yesterday's prompt"),
    turn("assistant", "08:00:10", "yesterday's reply"),
    turn("user", "10:00:00", "Fix the parser cache please"),
    turn("assistant", "10:01:00", "I fixed the cache key.\n\nIt forgot the branch."),
    turn(
        "user",
        "10:30:00",
        'Another Claude session sent a message: <teammate-message teammate_id="lead">ship it</teammate-message>'
    ),
    turn("assistant", "10:31:00", ""),
    turn("assistant", "10:32:00", "Shipped."),
];
TURNS[0].at = "2026-03-01T08:00:00.000Z";
TURNS[1].at = "2026-03-01T08:00:10.000Z";

const CHANGES: ComputedSessionChanges = {
    sessionId: "s-alpha",
    turns: [
        {
            turnId: "old",
            index: 0,
            at: "2026-03-01T08:00:05.000Z",
            files: [{ path: "/tmp/app/old.ts", via: "edit", confidence: "exact", toolUseIds: ["t0"] }],
            excluded: [],
        },
        {
            turnId: "fix",
            index: 1,
            at: iso("10:00:30"),
            files: [
                { path: "/tmp/app/parse.ts", via: "edit", confidence: "exact", toolUseIds: ["t1", "t2"] },
                {
                    path: "/tmp/scratch.md",
                    via: "write",
                    confidence: "exact",
                    toolUseIds: ["t3"],
                    agentIds: ["agent-1"],
                },
            ],
            excluded: [],
        },
        {
            turnId: "again",
            index: 2,
            at: iso("10:32:00"),
            files: [{ path: "/tmp/app/parse.ts", via: "edit", confidence: "exact", toolUseIds: ["t4"] }],
            excluded: [],
        },
    ],
    files: [],
    blobs: new Map(),
};

const SUBAGENTS: SessionSubagent[] = [
    {
        id: "agent-1",
        name: "fixer",
        description: "fix the cache",
        agentType: "general-purpose",
        model: null,
        toolUseId: "t3",
        startedAt: iso("10:05:00"),
        lastAt: iso("10:20:00"),
        state: "done",
        bytes: 10,
        filePath: "/tmp/agent-1.jsonl",
    },
    {
        id: "agent-old",
        name: null,
        description: "yesterday",
        agentType: "Explore",
        model: null,
        toolUseId: null,
        startedAt: "2026-03-01T08:00:00.000Z",
        lastAt: "2026-03-01T08:30:00.000Z",
        state: "done",
        bytes: 10,
        filePath: "/tmp/agent-old.jsonl",
    },
];

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
    return {
        id: "d_1_s-alpha",
        sessionId: "s-alpha",
        number: 1,
        prompt: "Keep the parser cache between runs?",
        options: ["a) keep it", "b) drop it"],
        state: "answered",
        option: "a",
        updatedTs: iso("13:00:00"),
        ...overrides,
    };
}

let scratch: Scratch;

beforeAll(async () => {
    scratch = await scratchRepo();
});

function deps(overrides: Partial<TimelineDetailDeps> = {}): TimelineDetailDeps {
    return {
        git: (args, cwd) => git(args, cwd),
        transcript: async () => ({ resolved: RESOLVED, turns: TURNS }),
        changes: () => CHANGES,
        subagents: () => SUBAGENTS,
        prs: async () => [pr(scratch.root)],
        threads: () => [threads(scratch.root)],
        fetchThreads: async () => {
            throw new Error("the host should not be asked");
        },
        prDetail: async () => prDetail(scratch.root),
        decisions: () => [decision()],
        facts: async (path) => ({
            path,
            root: path,
            repo: "app",
            branch: "feat/parser",
            head: scratch.second,
            origin: {
                url: "git@github.com:acme/app.git",
                host: "github.com",
                kind: "github",
                web: "https://github.com/acme/app",
            },
            branchUrl: null,
            headUrl: null,
        }),
        ...overrides,
    };
}

describe("timeline detail: commit", () => {
    test("a commit's message, files with their counts, branches and the PR that contains it", async () => {
        const detail = (await timelineDetail({
            request: { kind: "commit", id: `commit:${scratch.second}`, repo: scratch.root },
            deps: deps(),
            storage: await scratchStorage(),
            now: NOW,
        })) as CommitDetail & { cached: boolean };

        expect(detail).toMatchObject({
            kind: "commit",
            sha: scratch.second,
            subject: "fix: cache",
            body: "The cache key forgot the branch.",
            author: "Alice",
            email: "alice@example.com",
            files: [{ path: "parse.ts", status: "M", added: 2, removed: 1, binary: false }],
            prs: [{ ref: "acme/app#7", url: "https://github.com/acme/app/pull/7" }],
            diff: null,
            cached: false,
        });
        expect(detail.branches).toEqual(expect.arrayContaining(["feat/parser", "origin/feat/parser"]));
        expect(detail.branches).not.toContain("main");
    });

    test("the first commit lists added files, and a file's diff comes on demand", async () => {
        const storage = await scratchStorage();
        const detail = (await timelineDetail({
            request: { kind: "commit", id: scratch.first, repo: scratch.root, file: "parse.ts" },
            deps: deps(),
            storage,
            now: NOW,
        })) as CommitDetail;

        expect(detail.files.map((file) => [file.path, file.status, file.added])).toEqual([
            ["README.md", "A", 1],
            ["parse.ts", "A", 2],
        ]);
        expect(detail.diff).toMatchObject({ path: "parse.ts", truncated: false });
        expect(detail.diff?.text).toContain("+export const a = 1;");
        expect(detail.prs).toEqual([
            { ref: "acme/app#7", url: "https://github.com/acme/app/pull/7", title: "Parser rewrite", state: "OPEN" },
        ]);
    });

    test("a commit's detail is cached for a day and fresh reads it again; the repo is required", async () => {
        const storage = await scratchStorage();
        let calls = 0;
        const counting = deps({
            git: (args, cwd) => {
                calls++;
                return git(args, cwd);
            },
        });
        const request = { kind: "commit" as const, id: scratch.second, repo: scratch.root };

        await timelineDetail({ request, deps: counting, storage, now: NOW });
        const again = await timelineDetail({ request, deps: counting, storage, now: NOW });
        const fresh = await timelineDetail({ request: { ...request, fresh: true }, deps: counting, storage, now: NOW });

        expect(again.cached).toBe(true);
        expect(fresh.cached).toBe(false);
        expect(calls).toBe(8);
        await expect(
            timelineDetail({ request: { kind: "commit", id: scratch.second }, deps: counting, storage, now: NOW })
        ).rejects.toBeInstanceOf(TimelineDetailError);
    });
});

describe("timeline detail: push", () => {
    test("a push lists the commits between the tips, the remote and the PR of its branch", async () => {
        const detail = (await timelineDetail({
            request: {
                kind: "push",
                id: `push:feat/parser:${scratch.second}:1000`,
                repo: scratch.root,
                from: scratch.first,
            },
            deps: deps(),
            storage: await scratchStorage(),
            now: NOW,
        })) as PushDetail;

        expect(detail).toMatchObject({
            kind: "push",
            branch: "feat/parser",
            from: scratch.first,
            to: scratch.second,
            newBranch: false,
            truncated: false,
            remote: { kind: "github", web: "https://github.com/acme/app" },
            pr: { ref: "acme/app#7" },
        });
        expect(detail.commits.map((commit) => commit.subject)).toEqual(["fix: cache"]);
    });

    test("a new branch's push lists what it carried, newest first", async () => {
        const detail = (await timelineDetail({
            request: {
                kind: "push",
                id: `push:feat/parser:${scratch.second}:1000`,
                repo: scratch.root,
                from: "0".repeat(40),
            },
            deps: deps({ prs: async () => [] }),
            storage: await scratchStorage(),
            now: NOW,
        })) as PushDetail;

        expect(detail.newBranch).toBe(true);
        expect(detail.commits.map((commit) => commit.subject)).toEqual(["fix: cache", "feat: parser"]);
        expect(detail.pr).toBeNull();
    });
});

describe("timeline detail: session", () => {
    test("the period's prompts, the last reply, the files with their edit counts and the sub-agents", async () => {
        const detail = (await timelineDetail({
            request: { kind: "session", id: "turn:s-alpha", since: SINCE, until: NOW },
            deps: deps(),
            storage: await scratchStorage(),
            now: NOW,
        })) as SessionDetail;

        expect(detail).toMatchObject({
            kind: "session",
            sessionId: "s-alpha",
            provider: "claude",
            turns: 5,
            promptsTotal: 2,
            lastReply: { text: "Shipped." },
            filesTotal: 2,
            tokens: { calls: 0 },
            costUsd: null,
            warnings: [],
        });
        expect(detail.prompts.map((prompt) => prompt.text)).toEqual([
            "Fix the parser cache please",
            "Another Claude session sent a message: ship it",
        ]);
        expect(detail.prompts.map((prompt) => prompt.index)).toEqual([2, 4]);
        expect(detail.files).toEqual([
            { path: "/tmp/app/parse.ts", via: "edit", edits: 3, agents: 0 },
            { path: "/tmp/scratch.md", via: "write", edits: 1, agents: 1 },
        ]);
        expect(detail.subagents.map((agent) => agent.id)).toEqual(["agent-1"]);
    });

    test("a session without a readable transcript for its changes still answers", async () => {
        const detail = (await timelineDetail({
            request: { kind: "session", id: "s-alpha", since: SINCE, until: NOW },
            deps: deps({ changes: () => null }),
            storage: await scratchStorage(),
            now: NOW,
        })) as SessionDetail;
        expect(detail.files).toEqual([]);
        expect(detail.filesTotal).toBe(0);
    });
});

describe("timeline detail: PR event and CI", () => {
    test("the PR's summary, checks and the threads that arrived in the period", async () => {
        const detail = (await timelineDetail({
            request: { kind: "ci", id: "ci:x", pr: "https://github.com/acme/app/pull/7", since: SINCE, until: NOW },
            deps: deps(),
            storage: await scratchStorage(),
            now: NOW,
        })) as PrEventDetail;

        expect(detail.kind).toBe("pr");
        expect(detail.pr).toMatchObject({
            ref: "acme/app#7",
            state: "OPEN",
            ci: "failed",
            reviewDecision: "APPROVED",
            additions: 10,
            checks: [
                { name: "CI / test", status: "failed" },
                { name: "CI / lint", status: "success" },
            ],
        });
        expect(detail.threads).toMatchObject({ total: 2, open: 1 });
        expect(detail.threads.newSince.map((item) => [item.id, item.title, item.resolved])).toEqual([
            ["c-done", "done", true],
            ["c-today", "Guard the empty input", false],
        ]);
    });

    test("a PR event needs the PR's URL", async () => {
        await expect(
            timelineDetail({
                request: { kind: "pr", id: "pr-open:acme/app#7" },
                deps: deps(),
                storage: await scratchStorage(),
                now: NOW,
            })
        ).rejects.toThrow("--pr <url> is required");
    });
});

describe("timeline detail: review comment", () => {
    test("the whole thread comes from the cache when it holds the comment", async () => {
        const detail = (await timelineDetail({
            request: { kind: "thread", id: "thread:c-today", pr: "https://github.com/acme/app/pull/7" },
            deps: deps(),
            storage: await scratchStorage(),
            now: NOW,
        })) as ThreadDetail;

        expect(detail).toMatchObject({ kind: "thread", fetched: "cache", viewer: "alice", pr: { ref: "acme/app#7" } });
        expect(detail.thread.id).toBe("t1");
        expect(detail.thread.comments.map((comment) => comment.id)).toEqual(["c-old", "c-today"]);
    });

    test("a comment the cache does not know is fetched from the host; one it never had is an error", async () => {
        const fetched = threads(scratch.root);
        fetched.threads[0].comments.push({
            id: "c-new",
            author: { name: "Bob", username: "bob" },
            bodyMarkdown: "and this",
            createdAt: iso("14:00:00"),
            isDraft: false,
        });
        let asked = 0;
        const remote = deps({
            fetchThreads: async () => {
                asked++;
                return fetched;
            },
        });
        const storage = await scratchStorage();

        const detail = (await timelineDetail({
            request: { kind: "thread", id: "thread:c-new", pr: "https://github.com/acme/app/pull/7" },
            deps: remote,
            storage,
            now: NOW,
        })) as ThreadDetail;
        expect(detail.fetched).toBe("host");
        expect(detail.thread.comments.map((comment) => comment.id)).toContain("c-new");
        expect(asked).toBe(1);

        await expect(
            timelineDetail({
                request: { kind: "thread", id: "thread:c-gone", pr: "https://github.com/acme/app/pull/7" },
                deps: remote,
                storage,
                now: NOW,
            })
        ).rejects.toThrow("is not on");
    });
});

describe("timeline detail: decision", () => {
    test("the stored record, or an error naming the missing id", async () => {
        const storage = await scratchStorage();
        const detail = await timelineDetail({
            request: { kind: "decision", id: "decision:d_1_s-alpha" },
            deps: deps(),
            storage,
            now: NOW,
        });
        expect(detail).toMatchObject({ kind: "decision", record: { id: "d_1_s-alpha", option: "a" }, cached: false });
        await expect(
            timelineDetail({ request: { kind: "decision", id: "d_9" }, deps: deps(), storage, now: NOW })
        ).rejects.toThrow("no decision d_9");
    });
});
