import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewCommentClient } from "@app/github/lib/review-comments";
import type { CommandRunner } from "@genesiscz/utils/git/origins";
import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage";
import type { RepoFacts } from "../repo";
import { findBranchPr, findPrByRef } from "./find";
import { githubBackend, githubThread } from "./github";
import { gitlabBackend, gitlabPosition, gitlabThreads } from "./gitlab";
import { type FoundPr, forgetThreads, gitlabBaseUrl, type PrBackend, prThreads } from "./index";

// ─── find ─────────────────────────────────────────────────────────────────────

function facts(over: Partial<RepoFacts>): RepoFacts {
    return {
        path: "/work/app",
        root: "/work/app",
        repo: "app",
        branch: "feat/x",
        head: "h1",
        origin: { url: "git@github.com:acme/web.git", host: "github.com", kind: "github", web: null },
        branchUrl: null,
        headUrl: null,
        ...over,
    };
}

const refuseRunner: CommandRunner = async (cmd) => {
    throw new Error(`no host call expected, got ${cmd.join(" ")}`);
};

function runnerAnswering(answers: Array<[RegExp, unknown]>, calls: string[]): CommandRunner {
    return async (cmd) => {
        const line = cmd.join(" ");
        calls.push(line);
        const hit = answers.find(([pattern]) => pattern.test(line));
        return hit
            ? { code: 0, stdout: SafeJSON.stringify(hit[1]), stderr: "" }
            : { code: 1, stdout: "", stderr: `unexpected: ${line}` };
    };
}

describe("findBranchPr", () => {
    test("no origin remote and a detached HEAD answer provider null without asking a host", async () => {
        const noRemote = await findBranchPr({
            repo: "/work/app",
            runner: refuseRunner,
            readFacts: async () => facts({ origin: null }),
        });
        expect(noRemote).toMatchObject({ provider: null, reason: "no origin remote" });

        const detached = await findBranchPr({
            repo: "/work/app",
            runner: refuseRunner,
            readFacts: async () => facts({ branch: null }),
        });
        expect(detached).toMatchObject({ provider: null, reason: expect.stringContaining("detached HEAD") });

        const notGit = await findBranchPr({
            repo: "/tmp/x",
            runner: refuseRunner,
            readFacts: async () => facts({ root: null }),
        });
        expect(notGit).toMatchObject({ provider: null, reason: "not a git checkout" });
    });

    test("GitHub: the open PR of the branch wins over a newer merged one, with both shas", async () => {
        const calls: string[] = [];
        const row = (number: number, state: string, updatedAt: string) => ({
            number,
            title: `PR ${number}`,
            state,
            isDraft: false,
            author: { login: "alice" },
            headRefName: "feat/x",
            baseRefName: "main",
            headRefOid: `head${number}`,
            baseRefOid: `base${number}`,
            url: `https://github.com/acme/web/pull/${number}`,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt,
        });
        const found = await findBranchPr({
            repo: "/work/app",
            runner: runnerAnswering(
                [[/^gh pr list/, [row(3, "MERGED", "2026-03-01T00:00:00Z"), row(5, "OPEN", "2026-02-01T00:00:00Z")]]],
                calls
            ),
            readFacts: async () => facts({}),
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain("--head feat/x --state all");
        expect(found).toMatchObject({
            provider: "github",
            host: "github.com",
            project: "acme/web",
            number: 5,
            state: "OPEN",
            sourceBranch: "feat/x",
            targetBranch: "main",
            headSha: "head5",
            baseSha: "base5",
            author: "alice",
        });
    });

    test("GitLab: a merged-only MR is found, and its base sha comes from the MR itself", async () => {
        const calls: string[] = [];
        const mr = {
            iid: 9,
            title: "Fix y",
            state: "merged",
            draft: false,
            author: { username: "bob" },
            source_branch: "feat/x",
            target_branch: "main",
            sha: "headsha",
            web_url: "https://gitlab.example.com/group/app/-/merge_requests/9",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
        };
        const found = await findBranchPr({
            repo: "/work/app",
            runner: runnerAnswering(
                [
                    [/merge_requests\?/, [mr]],
                    [/merge_requests\/9$/, { ...mr, diff_refs: { base_sha: "basesha", head_sha: "headsha" } }],
                ],
                calls
            ),
            readFacts: async () =>
                facts({
                    origin: {
                        url: "git@gitlab.example.com:group/app.git",
                        host: "gitlab.example.com",
                        kind: "gitlab",
                        web: null,
                    },
                }),
        });

        expect(calls[0]).toContain("source_branch=feat%2Fx");
        expect(found).toMatchObject({
            provider: "gitlab",
            project: "group/app",
            number: 9,
            state: "MERGED",
            headSha: "headsha",
            baseSha: "basesha",
        });
    });

    test("no PR for the branch is an answer; a host that fails is an error, not 'none'", async () => {
        const none = await findBranchPr({
            repo: "/work/app",
            runner: runnerAnswering([[/^gh pr list/, []]], []),
            readFacts: async () => facts({}),
        });
        expect(none).toMatchObject({ provider: null, reason: expect.stringContaining("feat/x") });

        await expect(
            findBranchPr({ repo: "/work/app", runner: runnerAnswering([], []), readFacts: async () => facts({}) })
        ).rejects.toThrow("could not list PRs");
    });
});

describe("gitlabBaseUrl", () => {
    test("keeps a relative root in front of the project, and a port; a plain install is its origin", () => {
        const at = (url: string) => gitlabBaseUrl({ url, project: "group/app" });

        expect(at("https://git.example.com/gitlab/group/app/-/merge_requests/9")).toBe(
            "https://git.example.com/gitlab"
        );
        expect(at("http://git.example.com:8080/group/app/-/merge_requests/9")).toBe("http://git.example.com:8080");
        expect(at("https://git.example.com/group/app/-/merge_requests/9")).toBe("https://git.example.com");
    });
});

describe("findPrByRef", () => {
    test("a PR URL is viewed read-only and carries both shas; a bad ref is refused before any call", async () => {
        const calls: string[] = [];
        const found = await findPrByRef({
            ref: "https://github.com/acme/web/pull/12",
            runner: runnerAnswering(
                [
                    [
                        /^gh pr view 12 --repo github.com\/acme\/web/,
                        {
                            number: 12,
                            title: "Review me",
                            state: "OPEN",
                            isDraft: false,
                            author: { login: "alice" },
                            headRefName: "feat/y",
                            baseRefName: "main",
                            headRefOid: "h12",
                            baseRefOid: "b12",
                            url: "https://github.com/acme/web/pull/12",
                        },
                    ],
                ],
                calls
            ),
        });
        expect(calls).toHaveLength(1);
        expect(found).toMatchObject({
            provider: "github",
            number: 12,
            headSha: "h12",
            baseSha: "b12",
            crossRepository: false,
            headRepo: null,
            repoPath: null,
        });

        await expect(findPrByRef({ ref: "not a ref", runner: refuseRunner })).rejects.toThrow("--pr takes");
    });

    test("a PR from a fork says so, and names the fork, for `tools hub pr find --json` and the window", async () => {
        const found = await findPrByRef({
            ref: "https://github.com/acme/web/pull/13",
            runner: runnerAnswering(
                [
                    [
                        /^gh pr view 13 --repo github.com\/acme\/web/,
                        {
                            number: 13,
                            title: "From a fork",
                            state: "OPEN",
                            isDraft: false,
                            author: { login: "bob" },
                            headRefName: "main",
                            baseRefName: "main",
                            headRefOid: "h13",
                            baseRefOid: "b13",
                            isCrossRepository: true,
                            headRepository: { name: "web" },
                            headRepositoryOwner: { login: "bob" },
                            url: "https://github.com/acme/web/pull/13",
                        },
                    ],
                ],
                []
            ),
        });

        expect(found).toMatchObject({ crossRepository: true, headRepo: "bob/web" });
    });
});

// ─── position mapping ─────────────────────────────────────────────────────────

const ghPr: FoundPr = {
    provider: "github",
    host: "github.com",
    project: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    webUrl: "https://github.com/acme/web/pull/7",
    title: "Add x",
    state: "OPEN",
    draft: false,
    author: "alice",
    sourceBranch: "feat/x",
    targetBranch: "main",
    headSha: "head7",
    baseSha: "base7",
    crossRepository: false,
    headRepo: null,
    repoPath: "/work/app",
};

const glPr: FoundPr = {
    ...ghPr,
    provider: "gitlab",
    host: "gitlab.example.com",
    project: "group/app",
    url: "https://gitlab.example.com/group/app/-/merge_requests/7",
    webUrl: "https://gitlab.example.com/group/app/-/merge_requests/7",
    headSha: "HEAD",
};

function ghComment(over: Record<string, unknown> = {}) {
    return {
        id: "C_1",
        body: "Rename this.",
        createdAt: "2026-01-01T00:00:00Z",
        lastEditedAt: null,
        state: "SUBMITTED" as const,
        authorAssociation: "MEMBER",
        diffHunk: "@@ -1,2 +1,3 @@",
        commit: { oid: "c-now" },
        originalCommit: { oid: "c-then" },
        author: { login: "bob", avatarUrl: "https://example.com/bob.png", name: "Bob Example" },
        reactionGroups: [
            { content: "THUMBS_UP", viewerHasReacted: true, reactors: { totalCount: 2 } },
            { content: "EYES", viewerHasReacted: false, reactors: { totalCount: 0 } },
        ],
        ...over,
    };
}

function ghThread(over: Record<string, unknown> = {}) {
    return {
        id: "PRRT_1",
        isResolved: false,
        isOutdated: false,
        viewerCanResolve: true,
        viewerCanUnresolve: false,
        path: "src/a.ts",
        diffSide: "RIGHT" as const,
        startDiffSide: null,
        line: 12,
        startLine: null,
        originalLine: 10,
        originalStartLine: null,
        comments: { nodes: [ghComment()] },
        ...over,
    };
}

describe("GitHub position mapping", () => {
    test("RIGHT single line, LEFT multi-line, outdated falls back to the original line, pending is a draft", () => {
        expect(githubThread(ghThread())).toMatchObject({
            id: "PRRT_1",
            side: "additions",
            line: 12,
            startLine: undefined,
            outdated: false,
            resolvable: true,
            commitSha: "c-now",
            comments: [
                {
                    author: { name: "Bob Example", username: "bob", role: "MEMBER" },
                    isDraft: false,
                    reactions: [{ emoji: "👍", count: 2, mine: true }],
                },
            ],
        });

        expect(
            githubThread(ghThread({ diffSide: "LEFT", startDiffSide: "LEFT", line: 8, startLine: 5 }))
        ).toMatchObject({ side: "deletions", line: 8, startLine: 5 });

        const outdated = githubThread(
            ghThread({ isOutdated: true, line: null, startLine: null, originalLine: 10, originalStartLine: 7 })
        );
        expect(outdated).toMatchObject({ outdated: true, line: 10, startLine: 7, commitSha: "c-then" });
        expect(outdated.diffHunk).toBe("@@ -1,2 +1,3 @@");

        const pending = githubThread(ghThread({ comments: { nodes: [ghComment({ state: "PENDING" })] } }));
        expect(pending.comments[0].isDraft).toBe(true);
    });
});

describe("GitLab position mapping", () => {
    test("new_line is additions, old_line only is deletions, line_range gives the start, image positions are skipped", () => {
        expect(gitlabPosition({ position_type: "text", new_path: "a.ts", new_line: 4, old_line: 3 })).toEqual({
            path: "a.ts",
            oldPath: undefined,
            side: "additions",
            line: 4,
            startLine: undefined,
        });
        expect(gitlabPosition({ position_type: "text", new_path: "b.ts", old_path: "old/b.ts", old_line: 9 })).toEqual({
            path: "b.ts",
            oldPath: "old/b.ts",
            side: "deletions",
            line: 9,
            startLine: undefined,
        });
        expect(
            gitlabPosition({
                position_type: "text",
                new_path: "a.ts",
                new_line: 12,
                line_range: { start: { new_line: 10 }, end: { new_line: 12 } },
            })
        ).toMatchObject({ side: "additions", line: 12, startLine: 10 });
        expect(gitlabPosition({ position_type: "image", new_path: "logo.png" })).toBeNull();
    });

    test("threads: outdated by head sha, system and general notes skipped, drafts merged as isDraft", () => {
        const note = (id: number, over: Record<string, unknown> = {}) => ({
            id,
            body: `note ${id}`,
            created_at: "2026-01-01T00:00:00Z",
            resolvable: true,
            resolved: false,
            author: { username: "alice", name: "Alice Example", avatar_url: "https://example.com/a.png" },
            ...over,
        });
        const threads = gitlabThreads({
            discussions: [
                {
                    id: "d-current",
                    notes: [
                        note(1, {
                            position: { position_type: "text", new_path: "a.ts", new_line: 4, head_sha: "HEAD" },
                        }),
                        note(2, { system: true }),
                        note(3, { author: { username: "bob", name: "Bob Example" } }),
                    ],
                },
                {
                    id: "d-old",
                    notes: [
                        note(4, {
                            position: { position_type: "text", new_path: "a.ts", old_line: 2, head_sha: "OLD" },
                        }),
                    ],
                },
                { id: "d-general", notes: [note(5)] },
            ],
            drafts: [
                { id: 50, note: "my reply", discussion_id: "d-current" },
                { id: 51, note: "new line", position: { position_type: "text", new_path: "b.ts", new_line: 7 } },
                { id: 52, note: "top level" },
            ],
            me: { username: "bob", name: "Bob Example" },
            pr: glPr,
            draftedAt: "2026-01-03T00:00:00Z",
        });

        expect(threads.map((thread) => thread.id)).toEqual(["d-current", "d-old", "draft-51"]);
        expect(threads[0]).toMatchObject({ outdated: false, side: "additions", line: 4, resolvable: true });
        expect(threads[0].comments.map((comment) => [comment.id, comment.isDraft])).toEqual([
            ["1", false],
            ["3", false],
            ["50", true],
        ]);
        expect(threads[0].comments[0].author).toEqual({
            name: "Alice Example",
            username: "alice",
            avatarUrl: "https://example.com/a.png",
            role: "author",
        });
        expect(threads[1]).toMatchObject({ outdated: true, side: "deletions", line: 2, commitSha: "OLD" });
        expect(threads[2]).toMatchObject({ path: "b.ts", line: 7, resolvable: false });
        expect(threads[2].comments[0]).toMatchObject({ isDraft: true, bodyMarkdown: "new line" });
    });
});

// ─── GitHub verbs ─────────────────────────────────────────────────────────────

const TRICKY_BODY = `She said "don't" — and \`$HOME\` stays literal.\n\nSecond paragraph with 'quotes' and \\backslash.\n`;

/** Checked in order: a longer mutation name comes before the shorter one it contains. */
const GQL_OPS = [
    "submitPullRequestReview",
    "addPullRequestReviewThreadReply",
    "addPullRequestReviewThread",
    "addPullRequestReview",
    "updatePullRequestReviewComment",
    "deletePullRequestReviewComment",
    "unresolveReviewThread",
    "resolveReviewThread",
    "reviewThreads",
    "node(id",
    "viewer",
];

interface GqlCall {
    op: string;
    vars: Record<string, unknown>;
}

/**
 * A GitHub client that answers every read and draft write. 🛑 Unless `allowPublish`, the two
 * mutations that publish a review THROW, so any path that reaches them fails loudly.
 */
function fakeGithub(
    options: { pending?: boolean; commentState?: string; allowPublish?: boolean; allowComment?: boolean } = {}
) {
    const calls: GqlCall[] = [];
    const client: ReviewCommentClient = {
        async graphql<T>(query: string, vars: Record<string, unknown>): Promise<T> {
            const op = GQL_OPS.find((name) => query.includes(name)) ?? "?";
            calls.push({ op, vars });

            const publishes = op === "submitPullRequestReview" || (op === "addPullRequestReview" && vars.event);

            if (publishes && !options.allowPublish) {
                throw new Error(`🛑 ${op} reached outside publish`);
            }

            const pull = {
                id: "PR_1",
                headRefOid: "head7",
                reviews: {
                    nodes: options.pending
                        ? [{ id: "REV_mine", author: { login: "bob" }, comments: { totalCount: 3 } }]
                        : [],
                },
            };
            const answers: Record<string, unknown> = {
                viewer: { viewer: { login: "bob" }, repository: { pullRequest: pull } },
                reviewThreads: {
                    viewer: { login: "bob" },
                    repository: {
                        pullRequest: {
                            reviewThreads: {
                                pageInfo: { hasNextPage: false, endCursor: null },
                                nodes: [
                                    ghThread(),
                                    ghThread({ id: "PRRT_2", comments: { nodes: [ghComment({ state: "PENDING" })] } }),
                                ],
                            },
                        },
                    },
                },
                addPullRequestReview: { addPullRequestReview: { pullRequestReview: { id: "REV_new", url: "u" } } },
                addPullRequestReviewThread: {
                    addPullRequestReviewThread: {
                        thread: { id: "PRRT_9", comments: { nodes: [{ id: "C_9", url: "u9" }] } },
                    },
                },
                addPullRequestReviewThreadReply: {
                    addPullRequestReviewThreadReply: { comment: { id: "C_8", url: "u8" } },
                },
                "node(id": {
                    node: {
                        id: vars.id,
                        state: options.commentState ?? "PENDING",
                        // A reply first checks that its thread belongs to this PR.
                        pullRequest: { number: ghPr.number, repository: { nameWithOwner: ghPr.project } },
                    },
                },
                updatePullRequestReviewComment: {
                    updatePullRequestReviewComment: { pullRequestReviewComment: { id: vars.id } },
                },
                deletePullRequestReviewComment: { deletePullRequestReviewComment: { clientMutationId: null } },
                resolveReviewThread: { resolveReviewThread: { thread: { id: vars.threadId, isResolved: true } } },
                unresolveReviewThread: { unresolveReviewThread: { thread: { id: vars.threadId, isResolved: false } } },
                submitPullRequestReview: {
                    submitPullRequestReview: { pullRequestReview: { id: "REV_mine", url: "https://example.com/r" } },
                },
            };
            return answers[op] as T;
        },
        async createReviewComment(input) {
            calls.push({ op: "createReviewComment", vars: { ...input } });

            if (!options.allowComment) {
                throw new Error("a draft verb must not create a published review comment");
            }

            return { id: 91, html_url: "https://example.com/c91" };
        },
    };
    return { client, calls, backend: githubBackend({ pr: ghPr, client }) };
}

describe("GitHub verbs", () => {
    test("threads counts my pending comments as drafts", async () => {
        const { backend } = fakeGithub();
        const result = await backend.threads();
        expect(result.viewer).toBe("bob");
        expect(result.threads.map((thread) => thread.id)).toEqual(["PRRT_1", "PRRT_2"]);
        expect(result.draftCount).toBe(1);
    });

    test("reply: published or as a draft; the body survives quotes, newlines and backslashes", async () => {
        const now = fakeGithub();
        expect(await now.backend.reply({ threadId: "PRRT_1", body: TRICKY_BODY, draft: false })).toEqual({
            threadId: "PRRT_1",
            commentId: "C_8",
            isDraft: false,
            url: "u8",
        });
        const reply = now.calls.find((call) => call.op === "addPullRequestReviewThreadReply");
        expect(reply?.vars).toEqual({ threadId: "PRRT_1", body: TRICKY_BODY.trim(), reviewId: null });

        const drafted = fakeGithub({ pending: true });
        await drafted.backend.reply({ threadId: "PRRT_1", body: TRICKY_BODY, draft: true });
        expect(drafted.calls.find((call) => call.op === "addPullRequestReviewThreadReply")?.vars.reviewId).toBe(
            "REV_mine"
        );
    });

    test("draft add: a multi-line comment on the old side goes into the pending review", async () => {
        const { backend, calls } = fakeGithub();
        const added = await backend.draftAdd({
            path: "src/a.ts",
            side: "deletions",
            line: 8,
            startLine: 5,
            body: TRICKY_BODY,
        });
        expect(added).toEqual({ draftId: "C_9", threadId: "PRRT_9" });
        expect(calls.find((call) => call.op === "addPullRequestReviewThread")?.vars).toMatchObject({
            reviewId: "REV_new",
            path: "src/a.ts",
            line: 8,
            side: "LEFT",
            startLine: 5,
            startSide: "LEFT",
            body: TRICKY_BODY.trim(),
        });
    });

    test("comment: a new range comment on the old side is published alone, with its side and range", async () => {
        const { backend, calls } = fakeGithub({ pending: true, allowComment: true });
        expect(
            await backend.comment({ path: "src/a.ts", side: "deletions", line: 8, startLine: 5, body: TRICKY_BODY })
        ).toEqual({ published: true, commentId: "91", url: "https://example.com/c91" });
        expect(calls.find((call) => call.op === "createReviewComment")?.vars).toMatchObject({
            path: "src/a.ts",
            line: 8,
            side: "LEFT",
            start_line: 5,
            start_side: "LEFT",
            commit_id: "head7",
            body: TRICKY_BODY.trim(),
        });
        expect(calls.some((call) => call.op === "addPullRequestReviewThread")).toBe(false);
    });

    test("draft update and delete change pending comments only; a published comment is refused", async () => {
        const pending = fakeGithub();
        expect(await pending.backend.draftUpdate({ draftId: "C_9", body: TRICKY_BODY })).toEqual({ draftId: "C_9" });
        expect(pending.calls.find((call) => call.op === "updatePullRequestReviewComment")?.vars).toEqual({
            id: "C_9",
            body: TRICKY_BODY,
        });
        expect(await pending.backend.draftDelete("C_9")).toEqual({ draftId: "C_9", deleted: true });

        const published = fakeGithub({ commentState: "SUBMITTED" });
        await expect(published.backend.draftUpdate({ draftId: "C_1", body: "x" })).rejects.toThrow("already published");
        await expect(published.backend.draftDelete("C_1")).rejects.toThrow("already published");
        expect(published.calls.map((call) => call.op)).toEqual(["node(id", "node(id"]);
    });

    test("resolve and unresolve", async () => {
        const { backend, calls } = fakeGithub();
        expect(await backend.resolve({ threadId: "PRRT_1", resolved: true })).toEqual({
            threadId: "PRRT_1",
            resolved: true,
        });
        expect(await backend.resolve({ threadId: "PRRT_1", resolved: false })).toEqual({
            threadId: "PRRT_1",
            resolved: false,
        });
        expect(calls.map((call) => call.op)).toEqual(["resolveReviewThread", "unresolveReviewThread"]);
    });

    test("publish submits my pending review as COMMENT by default, or with the given event", async () => {
        const { backend, calls } = fakeGithub({ pending: true, allowPublish: true });
        expect(await backend.publish({ event: "COMMENT" })).toMatchObject({ event: "COMMENT", published: 3 });
        await backend.publish({ event: "REQUEST_CHANGES", body: "Needs tests." });
        const submits = calls.filter((call) => call.op === "submitPullRequestReview").map((call) => call.vars);
        expect(submits).toEqual([
            { reviewId: "REV_mine", event: "COMMENT", body: null },
            { reviewId: "REV_mine", event: "REQUEST_CHANGES", body: "Needs tests." },
        ]);

        const empty = fakeGithub({ allowPublish: true });
        await expect(empty.backend.publish({ event: "COMMENT" })).rejects.toThrow("no pending drafts");
    });
});

// ─── GitLab verbs (a fake GitLab over HTTP, through the real client) ──────────

interface GitLabCall {
    method: string;
    path: string;
    body: unknown;
}

const GITLAB_DIFF = [
    "@@ -1,4 +1,5 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
    " const e = 6;",
].join("\n");

/**
 * A fake GitLab that answers the reads and draft writes `tools hub pr` makes. 🛑 Unless
 * `allowPublish`, bulk publish and approve answer 500 and are recorded, so a leak fails the test.
 */
async function withFakeGitLab(
    options: { allowPublish?: boolean; drafts?: unknown[]; failSinglePublish?: boolean },
    run: (backend: PrBackend, calls: GitLabCall[]) => Promise<void>
): Promise<void> {
    const calls: GitLabCall[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const path = url.pathname.replace("/api/v4/projects/group%2Fapp/merge_requests/7", "");
            const text = await request.text();
            calls.push({ method: request.method, path, body: text ? SafeJSON.parse(text, { strict: true }) : null });

            if (/bulk_publish$|\/approve$/.test(path) && !options.allowPublish) {
                return new Response("🛑 publish reached outside publish", { status: 500 });
            }

            if (/^\/draft_notes\/\d+\/publish$/.test(path) && options.failSinglePublish) {
                return new Response("publish refused", { status: 403 });
            }

            if (request.method === "GET") {
                const reads: Record<string, unknown> = {
                    "/api/v4/user": { username: "bob", name: "Bob Example" },
                    "/discussions": [],
                    "/draft_notes": options.drafts ?? [],
                    "/diffs": [{ old_path: "src/a.ts", new_path: "src/a.ts", diff: GITLAB_DIFF }],
                    "": { diff_refs: { base_sha: "B", start_sha: "S", head_sha: "HEAD" } },
                };
                return Response.json(reads[path] ?? []);
            }

            if (request.method === "POST" && path === "/draft_notes") {
                const position = (SafeJSON.parse(text, { strict: true }) as { position?: unknown }).position;
                return Response.json({ id: 60, discussion_id: null, position: position ?? null });
            }

            if (request.method === "POST" && path.endsWith("/notes")) {
                return Response.json({ id: 70 });
            }

            if (request.method === "DELETE") {
                return new Response(null, { status: 204 });
            }

            return Response.json({});
        },
    });

    try {
        const api = { host: `http://localhost:${server.port}`, token: "t", project: "group/app" };
        await run(gitlabBackend({ pr: glPr, api }), calls);
    } finally {
        server.stop(true);
    }
}

const writes = (calls: GitLabCall[]) => calls.filter((call) => call.method !== "GET");

describe("GitLab verbs", () => {
    test("reply as a draft or at once; the body survives intact", async () => {
        await withFakeGitLab({}, async (backend, calls) => {
            expect(await backend.reply({ threadId: "d1", body: TRICKY_BODY, draft: true })).toEqual({
                threadId: "d1",
                commentId: "60",
                isDraft: true,
            });
            expect(await backend.reply({ threadId: "d1", body: TRICKY_BODY, draft: false })).toEqual({
                threadId: "d1",
                commentId: "70",
                isDraft: false,
            });
            expect(writes(calls)).toEqual([
                {
                    method: "POST",
                    path: "/draft_notes",
                    body: { note: TRICKY_BODY, in_reply_to_discussion_id: "d1" },
                },
                { method: "POST", path: "/discussions/d1/notes", body: { body: TRICKY_BODY } },
            ]);
        });
    });

    test("draft add: a context line carries both numbers; a range carries GitLab line codes", async () => {
        await withFakeGitLab({}, async (backend, calls) => {
            expect(await backend.draftAdd({ path: "src/a.ts", side: "additions", line: 4, body: "x" })).toEqual({
                draftId: "60",
                threadId: "draft-60",
            });
            await backend.draftAdd({ path: "src/a.ts", side: "additions", line: 3, startLine: 2, body: "y" });
            await backend.draftAdd({ path: "src/a.ts", side: "deletions", line: 2, body: "z" });

            const sha = createHash("sha1").update("src/a.ts").digest("hex");
            const positions = writes(calls).map(
                (call) => (call.body as { position: Record<string, unknown> }).position
            );
            expect(positions[0]).toMatchObject({
                base_sha: "B",
                head_sha: "HEAD",
                position_type: "text",
                new_path: "src/a.ts",
                old_line: 3,
                new_line: 4,
            });
            expect(positions[1]).toMatchObject({
                old_line: null,
                new_line: 3,
                line_range: {
                    start: { line_code: `${sha}_3_2`, type: "new", old_line: null, new_line: 2 },
                    end: { line_code: `${sha}_3_3`, type: "new", old_line: null, new_line: 3 },
                },
            });
            expect(positions[2]).toMatchObject({ old_line: 2, new_line: null });

            await expect(
                backend.draftAdd({ path: "src/a.ts", side: "additions", line: 40, body: "x" })
            ).rejects.toThrow("not in the MR diff");
            await expect(backend.draftAdd({ path: "nope.ts", side: "additions", line: 1, body: "x" })).rejects.toThrow(
                "not changed"
            );
        });
    });

    test("comment: an old-side line is drafted at its position, then only that draft is published", async () => {
        await withFakeGitLab({}, async (backend, calls) => {
            expect(await backend.comment({ path: "src/a.ts", side: "deletions", line: 2, body: TRICKY_BODY })).toEqual({
                published: true,
            });
            expect(writes(calls).map((call) => `${call.method} ${call.path}`)).toEqual([
                "POST /draft_notes",
                "PUT /draft_notes/60/publish",
            ]);
            expect((writes(calls)[0].body as { position: unknown }).position).toMatchObject({
                old_line: 2,
                new_line: null,
            });
        });

        await withFakeGitLab({ failSinglePublish: true }, async (backend, calls) => {
            await expect(backend.comment({ path: "src/a.ts", side: "additions", line: 4, body: "x" })).rejects.toThrow(
                "the draft was deleted again"
            );
            expect(writes(calls).map((call) => `${call.method} ${call.path}`)).toEqual([
                "POST /draft_notes",
                "PUT /draft_notes/60/publish",
                "DELETE /draft_notes/60",
            ]);
        });
    });

    test("draft update, delete, resolve and unresolve", async () => {
        await withFakeGitLab({}, async (backend, calls) => {
            await backend.draftUpdate({ draftId: "60", body: TRICKY_BODY });
            await backend.draftDelete("60");
            await backend.resolve({ threadId: "d1", resolved: true });
            await backend.resolve({ threadId: "d1", resolved: false });
            expect(writes(calls)).toEqual([
                { method: "PUT", path: "/draft_notes/60", body: { note: TRICKY_BODY } },
                { method: "DELETE", path: "/draft_notes/60", body: null },
                { method: "PUT", path: "/discussions/d1", body: { resolved: true } },
                { method: "PUT", path: "/discussions/d1", body: { resolved: false } },
            ]);
            await expect(backend.resolve({ threadId: "draft-60", resolved: true })).rejects.toThrow("draft thread");
            await expect(backend.draftDelete("abc")).rejects.toThrow("positive number");
        });
    });

    test("publish bulk-publishes my drafts; approve also approves; request-changes is refused before any call", async () => {
        await withFakeGitLab({ allowPublish: true, drafts: [{ id: 60, note: "x" }] }, async (backend, calls) => {
            expect(await backend.publish({ event: "COMMENT" })).toEqual({ event: "COMMENT", published: 1 });
            await backend.publish({ event: "APPROVE" });
            expect(writes(calls).map((call) => call.path)).toEqual([
                "/draft_notes/bulk_publish",
                "/draft_notes/bulk_publish",
                "/approve",
            ]);

            const before = calls.length;
            await expect(backend.publish({ event: "REQUEST_CHANGES" })).rejects.toThrow("no request-changes");
            expect(calls.length).toBe(before);
        });
    });
});

// ─── only publish publishes ───────────────────────────────────────────────────

/** Every verb except `publish`, with inputs each backend accepts. */
async function everyNonPublishVerb(backend: PrBackend): Promise<void> {
    await backend.threads();
    await backend.reply({ threadId: "d1", body: "r", draft: true });
    await backend.reply({ threadId: "d1", body: "r", draft: false });
    await backend.draftAdd({ path: "src/a.ts", side: "additions", line: 4, body: "d" });
    await backend.comment({ path: "src/a.ts", side: "additions", line: 4, body: "c" });
    await backend.draftUpdate({ draftId: "60", body: "u" });
    await backend.draftDelete("60");
    await backend.resolve({ threadId: "d1", resolved: true });
    await backend.resolve({ threadId: "d1", resolved: false });
}

describe("only publish publishes", () => {
    test("GitHub: no other verb reaches submitPullRequestReview or a submitted addPullRequestReview", async () => {
        const { backend, calls } = fakeGithub({ allowComment: true });
        await everyNonPublishVerb(backend);
        expect(calls.some((call) => call.op === "submitPullRequestReview")).toBe(false);
        expect(calls.some((call) => call.op === "addPullRequestReview" && call.vars.event)).toBe(false);

        // Positive control: the same fake does throw when publish runs.
        const guarded = fakeGithub({ pending: true });
        await expect(guarded.backend.publish({ event: "COMMENT" })).rejects.toThrow("reached outside publish");
    });

    test("GitLab: no other verb reaches bulk_publish or approve", async () => {
        await withFakeGitLab({}, async (backend, calls) => {
            await everyNonPublishVerb(backend);
            expect(calls.filter((call) => /bulk_publish|approve/.test(call.path))).toEqual([]);
        });

        await withFakeGitLab({ drafts: [{ id: 60 }] }, async (backend, calls) => {
            await expect(backend.publish({ event: "COMMENT" })).rejects.toThrow("bulk publish failed");
            expect(calls.filter((call) => /bulk_publish/.test(call.path))).toHaveLength(1);
        });
    });

    test("the CLI calls backend.publish from the publish command only", () => {
        const source = readFileSync(join(import.meta.dir, "..", "..", "index.ts"), "utf8");
        const calls = [...source.matchAll(/\.publish\(/g)].map((match) => match.index ?? 0);
        const publishCommand = source.indexOf('pr.command("publish")');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBeGreaterThan(publishCommand);
    });
});

// ─── cache ────────────────────────────────────────────────────────────────────

describe("prThreads cache", () => {
    test("30 s cache per PR, bypassed by noCache, dropped by forgetThreads and by a new head", async () => {
        let reads = 0;
        const unused = async (): Promise<never> => {
            throw new Error("only threads is read here");
        };
        const full: PrBackend = {
            async threads() {
                reads++;
                return { threads: [], draftCount: 0, viewer: "bob" };
            },
            reply: unused,
            draftAdd: unused,
            comment: unused,
            draftUpdate: unused,
            draftDelete: unused,
            resolve: unused,
            publish: unused,
        };
        const storage = new Storage("hub-pr-test");
        await forgetThreads({ pr: ghPr, storage });

        expect((await prThreads({ pr: ghPr, backend: full, storage })).cached).toBe(false);
        expect((await prThreads({ pr: ghPr, backend: full, storage })).cached).toBe(true);
        expect(reads).toBe(1);

        expect((await prThreads({ pr: ghPr, backend: full, storage, noCache: true })).cached).toBe(false);
        expect((await prThreads({ pr: { ...ghPr, headSha: "newer" }, backend: full, storage })).cached).toBe(false);
        await forgetThreads({ pr: ghPr, storage });
        expect((await prThreads({ pr: ghPr, backend: full, storage })).cached).toBe(false);
        expect(reads).toBe(4);
    });
});

// ─── the review window's argv ─────────────────────────────────────────────────

describe("the review window's argv", () => {
    // window-argv.json is what Swift's PRCommand builds (PRThreadsTests pins that); here the real CLI
    // must parse each one. A folder that is no git checkout makes every verb stop at "no PR" before
    // any host call, so nothing is posted and nothing is sent.
    test("the CLI parses every argv the window builds and answers with {error, code}", async () => {
        const fixture = SafeJSON.parse(readFileSync(join(import.meta.dir, "window-argv.json"), "utf8"), {
            strict: true,
        }) as { argv: Record<string, string[]>; answers: Record<string, { code: string; error?: string }> };
        const scratch = mkdtempSync(join(tmpdir(), "hub-pr-argv-"));
        const bodyFile = join(scratch, "b.md");
        writeFileSync(bodyFile, "probe\n");
        const entry = join(import.meta.dir, "..", "..", "index.ts");

        const answers = await Promise.all(
            Object.entries(fixture.argv).map(async ([name, argv]) => {
                expect(argv.slice(0, 2)).toEqual(["hub", "pr"]);
                const args = argv
                    .slice(1)
                    .map((arg) => (arg === "/tmp/b.md" ? bodyFile : arg.replace("/work/shop", scratch)));
                const child = Bun.spawn(["bun", entry, ...args], {
                    cwd: scratch,
                    env: process.env,
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const [stdout, stderr, code] = await Promise.all([
                    new Response(child.stdout).text(),
                    new Response(child.stderr).text(),
                    child.exited,
                ]);
                return { name, stdout, stderr, code };
            })
        );

        for (const { name, stdout, stderr, code } of answers) {
            expect({ name, unknownOption: /unknown option|unknown command|missing required/.test(stderr) }).toEqual({
                name,
                unknownOption: false,
            });
            expect({ name, code, answer: SafeJSON.parse(stdout, { strict: true }) }).toMatchObject({
                name,
                code: 1,
                answer: fixture.answers[name] ?? { code: "no-pr", error: "not a git checkout" },
            });
        }
    });
});
