import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realOctokit from "@genesiscz/utils/github/octokit";
import type { ParsedReviewThread, ReviewThread } from "@genesiscz/utils/github/types";

type GraphqlCall = { query: string; variables: Record<string, unknown> };
type ReadCall = { kind: string; cursor: string | undefined; variables: Record<string, unknown> };

let writeCalls: GraphqlCall[] = [];
let writeFailure: unknown = null;
let writeRule: ((call: GraphqlCall) => Error | null) | null = null;
let readCalls: ReadCall[] = [];
let readScript: Record<string, unknown> = {};

const writeClient = {
    graphql: async (query: string, variables: Record<string, unknown>) => {
        const call = { query, variables };
        writeCalls.push(call);

        if (writeFailure) {
            throw writeFailure;
        }

        const ruleError = writeRule?.(call);
        if (ruleError) {
            throw ruleError;
        }

        if (query.includes("addPullRequestReviewThreadReply")) {
            return { addPullRequestReviewThreadReply: { comment: { id: "comment-1" } } };
        }

        return { resolveReviewThread: { thread: { isResolved: true } } };
    },
};

/** Which of the six review queries this call is, read from its variables and its text. */
function readKind(query: string, variables: Record<string, unknown>): string {
    if ("threadId" in variables) {
        return "thread-comments";
    }

    if (!("cursor" in variables)) {
        return "first";
    }

    if (query.includes("reviewThreads(")) {
        return "threads";
    }

    return query.includes("reviews(") ? "reviews" : "pr-comments";
}

// The read client carries the env token, a fine-grained PAT that may not see the repository at all
// (a transferred repo answers NOT_FOUND), and withGhFallback retries reads only. A mutation that reaches
// it throws, so a write that goes through it fails loudly instead of passing quietly. A read answers from
// `readScript`, keyed `<kind>:<cursor>`, and an unscripted read throws too.
const readClient = {
    graphql: async (query: string, variables: Record<string, unknown>) => {
        if (query.includes("mutation")) {
            throw new Error("a write went through the env-token read client");
        }

        const kind = readKind(query, variables);
        const cursor = typeof variables.cursor === "string" ? variables.cursor : undefined;
        readCalls.push({ kind, cursor, variables });
        const key = `${kind}:${cursor ?? ""}`;

        if (!(key in readScript)) {
            throw new Error(`unscripted read ${key}`);
        }

        return readScript[key];
    },
};

mock.module("@genesiscz/utils/github/octokit", () => ({
    ...realOctokit,
    getOctokit: () => readClient,
    getOctokitForWrite: () => writeClient,
    getGhCliToken: () => undefined,
}));

const {
    batchReply,
    batchReplyAndResolve,
    batchResolveThreads,
    calculateReviewStats,
    fetchPRReviewThreads,
    markThreadResolved,
    parseThreads,
    replyToThread,
} = await import("./review-threads");

beforeEach(() => {
    writeCalls = [];
    writeFailure = null;
    writeRule = null;
    readCalls = [];
    readScript = {};
});

describe("review thread writes", () => {
    test("a reply goes through the write client, never the env-token read client", async () => {
        const commentId = await replyToThread("PRRT_one", "Fixed in abc1234");

        expect(commentId).toBe("comment-1");
        expect(writeCalls).toHaveLength(1);
        expect(writeCalls[0].query).toContain("addPullRequestReviewThreadReply");
        expect(writeCalls[0].variables).toEqual({ pullRequestReviewThreadId: "PRRT_one", body: "Fixed in abc1234" });
    });

    test("a resolve goes through the write client", async () => {
        expect(await markThreadResolved("PRRT_one")).toBe(true);
        expect(writeCalls.map((call) => call.query.includes("resolveReviewThread"))).toEqual([true]);
    });

    test("a failed reply keeps GitHub's reason next to the thread id", async () => {
        writeFailure = new Error("Could not resolve to a node with the global id of 'PRRT_one'.");

        const result = await batchReply(["PRRT_one"], "Fixed in abc1234");

        expect(result.replied).toBe(0);
        expect(result.failed).toEqual(["PRRT_one"]);
        expect(result.errors).toEqual([
            "PRRT_one reply: Could not resolve to a node with the global id of 'PRRT_one'.",
        ]);
    });

    test("a failed resolve keeps its reason too", async () => {
        writeFailure = new Error("Resource not accessible by personal access token");

        const result = await batchResolveThreads(["PRRT_one"]);

        expect(result.failed).toEqual(["PRRT_one"]);
        expect(result.errors).toEqual(["PRRT_one resolve: Resource not accessible by personal access token"]);
    });

    test("a working write client replies to and resolves every thread with no errors", async () => {
        const result = await batchReplyAndResolve(["PRRT_one", "PRRT_two"], "Fixed in abc1234");

        expect(result).toEqual({ replied: 2, resolved: 2, failed: [], errors: [] });
        expect(writeCalls).toHaveLength(4);
    });
});

describe("batch review thread writes", () => {
    const badThread = (call: GraphqlCall, id: string, message: string): Error | null =>
        call.variables.threadId === id || call.variables.pullRequestReviewThreadId === id ? new Error(message) : null;

    test("a batch resolve continues past a failure and reports every thread, success or not, as progress", async () => {
        writeRule = (call) => badThread(call, "PRRT_b", "thread is outdated");
        const progress: Array<[number, number]> = [];

        const result = await batchResolveThreads(["PRRT_a", "PRRT_b", "PRRT_c"], {
            onProgress: (done, total) => progress.push([done, total]),
        });

        expect(result).toEqual({
            resolved: 2,
            failed: ["PRRT_b"],
            errors: ["PRRT_b resolve: thread is outdated"],
        });
        expect(progress).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ]);
    });

    test("a batch reply continues past a failure and counts only the replies that landed", async () => {
        writeRule = (call) => badThread(call, "PRRT_a", "locked conversation");
        const progress: Array<[number, number]> = [];

        const result = await batchReply(["PRRT_a", "PRRT_b"], "Fixed", {
            onProgress: (done, total) => progress.push([done, total]),
        });

        expect(result).toEqual({ replied: 1, failed: ["PRRT_a"], errors: ["PRRT_a reply: locked conversation"] });
        expect(progress).toEqual([
            [1, 2],
            [2, 2],
        ]);
    });

    test("a reply that lands stays when the resolve fails, and the thread is listed as failed", async () => {
        writeRule = (call) => (call.query.includes("resolveReviewThread") ? new Error("not resolvable") : null);

        const result = await batchReplyAndResolve(["PRRT_a"], "Fixed");

        expect(result).toEqual({
            replied: 1,
            resolved: 0,
            failed: ["PRRT_a"],
            errors: ["PRRT_a resolve: not resolvable"],
        });
        expect(writeCalls.map((call) => call.query.includes("addPullRequestReviewThreadReply"))).toEqual([true, false]);
    });

    test("a reply that fails never tries to resolve that thread", async () => {
        writeRule = (call) => badThread(call, "PRRT_a", "locked conversation");
        const progress: Array<[number, number]> = [];

        const result = await batchReplyAndResolve(["PRRT_a", "PRRT_b"], "Fixed", {
            onProgress: (done, total) => progress.push([done, total]),
        });

        expect(result).toEqual({
            replied: 1,
            resolved: 1,
            failed: ["PRRT_a"],
            errors: ["PRRT_a reply: locked conversation"],
        });
        const resolved = writeCalls.filter((call) => call.query.includes("resolveReviewThread"));
        expect(resolved.map((call) => call.variables.threadId)).toEqual(["PRRT_b"]);
        expect(progress).toEqual([
            [1, 2],
            [2, 2],
        ]);
    });

    test("a failure that is not an Error is reported as its text", async () => {
        writeFailure = "rate limited";

        const result = await batchReply(["PRRT_a"], "Fixed");

        expect(result.errors).toEqual(["PRRT_a reply: rate limited"]);
    });
});

type CommentSpec = { id: string; body: string; login?: string | null; diffHunk?: string | null };

function commentEdge({ id, body, login = "carol", diffHunk = null }: CommentSpec) {
    return {
        node: {
            id,
            author: login === null ? null : { login },
            body,
            createdAt: "2026-03-10T09:00:00Z",
            diffHunk,
        },
    };
}

function connection<T>(edges: T[], nextCursor: string | null = null) {
    return { pageInfo: { hasNextPage: nextCursor !== null, endCursor: nextCursor }, edges };
}

function threadEdge(id: string, comments: ReturnType<typeof commentEdge>[], commentsNext: string | null = null) {
    return {
        node: {
            id,
            isResolved: false,
            path: "src/a.ts",
            line: 12,
            startLine: null,
            comments: connection(comments, commentsNext),
        },
    };
}

function reviewEdge(id: string, state: string, body: string, createdAt: string, login: string | null = "frank") {
    return { node: { id, author: login === null ? null : { login }, body, state, createdAt } };
}

function prCommentEdge(id: string, body: string, createdAt: string) {
    return { node: { id, author: { login: "gina" }, body, createdAt } };
}

function firstPage(over: Record<string, unknown>) {
    return {
        repository: {
            pullRequest: {
                title: "Add cache",
                state: "OPEN",
                headRefName: "feat/x",
                baseRefName: "main",
                reviewThreads: connection([]),
                reviews: connection([]),
                comments: connection([]),
                ...over,
            },
        },
    };
}

describe("fetchPRReviewThreads", () => {
    test("one page returns the pull request, its threads and the usable review and conversation comments in time order", async () => {
        readScript["first:"] = firstPage({
            reviewThreads: connection([threadEdge("T1", [commentEdge({ id: "C1", body: "Fix this bug" })])]),
            reviews: connection([
                reviewEdge("RV1", "APPROVED", "  Ship it  ", "2026-03-09T08:00:00Z"),
                reviewEdge("RV2", "COMMENTED", "   ", "2026-03-08T08:00:00Z", null),
                reviewEdge("RV3", "PENDING", "draft", "2026-03-07T08:00:00Z"),
            ]),
            comments: connection([
                prCommentEdge("PC1", "Thanks", "2026-03-10T08:00:00Z"),
                prCommentEdge("PC2", "  ", "2026-03-06T08:00:00Z"),
            ]),
        });

        const info = await fetchPRReviewThreads("acme", "widgets", 77);

        expect(info.title).toBe("Add cache");
        expect(info.state).toBe("OPEN");
        expect(info.headRefName).toBe("feat/x");
        expect(info.baseRefName).toBe("main");
        expect(info.threads).toEqual([
            {
                id: "T1",
                isResolved: false,
                path: "src/a.ts",
                line: 12,
                startLine: null,
                comments: [
                    {
                        id: "C1",
                        author: "carol",
                        body: "Fix this bug",
                        createdAt: "2026-03-10T09:00:00Z",
                        diffHunk: null,
                    },
                ],
            },
        ]);
        expect(info.prComments).toEqual([
            {
                id: "RV2",
                author: "ghost",
                body: "(no review body)",
                createdAt: "2026-03-08T08:00:00Z",
                type: "review",
                reviewState: "COMMENTED",
            },
            {
                id: "RV1",
                author: "frank",
                body: "Ship it",
                createdAt: "2026-03-09T08:00:00Z",
                type: "review",
                reviewState: "APPROVED",
            },
            { id: "PC1", author: "gina", body: "Thanks", createdAt: "2026-03-10T08:00:00Z", type: "comment" },
        ]);
        expect(readCalls).toHaveLength(1);
        expect(readCalls[0].variables).toEqual({ owner: "acme", repo: "widgets", pr: 77 });
    });

    test("a comment whose author was deleted is attributed to ghost", async () => {
        readScript["first:"] = firstPage({
            reviewThreads: connection([threadEdge("T1", [commentEdge({ id: "C1", body: "Hi", login: null })])]),
        });

        const info = await fetchPRReviewThreads("acme", "widgets", 77);

        expect(info.threads[0].comments[0].author).toBe("ghost");
    });

    test("every connection is followed by its cursor until it has no next page", async () => {
        readScript["first:"] = firstPage({
            reviewThreads: connection([threadEdge("T1", [commentEdge({ id: "C1", body: "first" })], "tc-1")], "tp-1"),
            reviews: connection([reviewEdge("RV1", "COMMENTED", "r1", "2026-03-01T08:00:00Z")], "rp-1"),
            comments: connection([prCommentEdge("PC1", "p1", "2026-03-02T08:00:00Z")], "cp-1"),
        });
        readScript["threads:tp-1"] = {
            repository: {
                pullRequest: {
                    reviewThreads: connection([threadEdge("T2", [commentEdge({ id: "C2", body: "second" })])]),
                },
            },
        };
        readScript["reviews:rp-1"] = {
            repository: {
                pullRequest: {
                    reviews: connection([reviewEdge("RV2", "DISMISSED", "r2", "2026-03-03T08:00:00Z")], "rp-2"),
                },
            },
        };
        readScript["reviews:rp-2"] = {
            repository: {
                pullRequest: {
                    reviews: connection([reviewEdge("RV3", "CHANGES_REQUESTED", "r3", "2026-03-04T08:00:00Z")]),
                },
            },
        };
        readScript["pr-comments:cp-1"] = {
            repository: { pullRequest: { comments: connection([prCommentEdge("PC2", "p2", "2026-03-05T08:00:00Z")]) } },
        };
        readScript["thread-comments:tc-1"] = {
            node: { comments: connection([commentEdge({ id: "C1b", body: "more" })], "tc-2") },
        };
        readScript["thread-comments:tc-2"] = {
            node: { comments: connection([commentEdge({ id: "C1c", body: "even more" })]) },
        };

        const info = await fetchPRReviewThreads("acme", "widgets", 77);

        expect(info.threads.map((thread) => thread.id)).toEqual(["T1", "T2"]);
        expect(info.threads[0].comments.map((comment) => comment.id)).toEqual(["C1", "C1b", "C1c"]);
        expect(info.prComments.map((comment) => comment.id)).toEqual(["RV1", "PC1", "RV2", "RV3", "PC2"]);
        expect(readCalls.map((call) => `${call.kind}:${call.cursor ?? ""}`).sort()).toEqual(
            [
                "first:",
                "reviews:rp-1",
                "reviews:rp-2",
                "pr-comments:cp-1",
                "threads:tp-1",
                "thread-comments:tc-1",
                "thread-comments:tc-2",
            ].sort()
        );
        expect(readCalls.find((call) => call.kind === "thread-comments")?.variables.threadId).toBe("T1");
    });

    test("a pull request that does not exist is an error naming the repository", async () => {
        readScript["first:"] = { repository: { pullRequest: null } };

        await expect(fetchPRReviewThreads("acme", "widgets", 404)).rejects.toThrow("PR #404 not found in acme/widgets");
    });

    test("pages that come back empty stop the walk and keep what was already read", async () => {
        readScript["first:"] = firstPage({
            reviewThreads: connection([threadEdge("T1", [commentEdge({ id: "C1", body: "first" })], "tc-1")], "tp-1"),
            reviews: connection([reviewEdge("RV1", "COMMENTED", "r1", "2026-03-01T08:00:00Z")], "rp-1"),
        });
        readScript["threads:tp-1"] = { repository: { pullRequest: null } };
        readScript["reviews:rp-1"] = { repository: { pullRequest: null } };
        readScript["thread-comments:tc-1"] = { node: null };

        const info = await fetchPRReviewThreads("acme", "widgets", 77);

        expect(info.threads.map((thread) => thread.id)).toEqual(["T1"]);
        expect(info.threads[0].comments.map((comment) => comment.id)).toEqual(["C1"]);
        expect(info.prComments.map((comment) => comment.id)).toEqual(["RV1"]);
    });
});

function rawThread(over: Partial<ReviewThread> & { body?: string; diffHunk?: string | null } = {}): ReviewThread {
    const { body = "Plain note", diffHunk = null, ...rest } = over;

    return {
        id: "T1",
        isResolved: false,
        path: "src/a.ts",
        line: 12,
        startLine: null,
        comments: [{ id: "C1", author: "carol", body, createdAt: "2026-03-10T09:00:00Z", diffHunk }],
        ...rest,
    };
}

function parseOne(over: Partial<ReviewThread> & { body?: string; diffHunk?: string | null } = {}): ParsedReviewThread {
    return parseThreads([rawThread(over)])[0];
}

describe("parseThreads", () => {
    test("skips threads without comments and numbers the rest from one", () => {
        const empty: ReviewThread = { ...rawThread({ id: "T0" }), comments: [] };

        const parsed = parseThreads([empty, rawThread({ id: "T1" }), rawThread({ id: "T2" })]);

        expect(parsed.map((thread) => [thread.threadId, thread.threadNumber])).toEqual([
            ["T1", 1],
            ["T2", 2],
        ]);
    });

    test("takes status, place, author and ids from the thread and its first comment, and the rest as replies", () => {
        const thread: ReviewThread = {
            id: "T9",
            isResolved: true,
            path: "src/b.ts",
            line: 20,
            startLine: 18,
            comments: [
                { id: "C1", author: "carol", body: "Please rename", createdAt: "2026-03-10T09:00:00Z", diffHunk: null },
                { id: "C2", author: "dave", body: "Done", createdAt: "2026-03-10T10:00:00Z", diffHunk: null },
            ],
        };

        expect(parseThreads([thread])[0]).toEqual({
            threadId: "T9",
            threadNumber: 1,
            status: "resolved",
            severity: "low",
            file: "src/b.ts",
            line: 20,
            startLine: 18,
            author: "carol",
            title: "Please rename",
            issue: "Please rename",
            diffHunk: null,
            suggestedCode: null,
            firstCommentId: "C1",
            createdAt: "2026-03-10T09:00:00Z",
            replies: [{ author: "dave", body: "Done", id: "C2", createdAt: "2026-03-10T10:00:00Z" }],
        });
        expect(parseOne().status).toBe("unresolved");
    });

    test.each([
        ["this is a critical path", "high"],
        ["HIGH-PRIORITY: fix", "high"],
        ["![high](https://example.com/h.svg) null deref", "high"],
        ["found a security vulnerability here", "high"],
        ["there is a bug in the loop", "high"],
        ["consider a refactor", "medium"],
        ["Suggestion: use a map", "medium"],
        ["performance could be better", "medium"],
        ["style nit", "medium"],
        ["![medium](https://example.com/m.svg) wording", "medium"],
        ["we should debug this later", "low"],
        ["thanks for the change", "low"],
    ] as const)("severity of %p is %s", (body, severity) => {
        expect(parseOne({ body }).severity).toBe(severity);
    });

    test("the title is the first content line without heading marks, bold or backticks", () => {
        expect(parseOne({ body: "![high](u)\n\n## **Use `map`** here\nmore" }).title).toBe("Use map here");
    });

    test("a title over 60 characters is cut to 57 plus dots, and a body of only badges gets a fixed title", () => {
        expect(parseOne({ body: "x".repeat(80) }).title).toBe(`${"x".repeat(57)}...`);
        expect(parseOne({ body: "![high](u)" }).title).toBe("Review Comment");
    });

    test("the issue text drops severity badges but keeps code", () => {
        const issue = parseOne({
            body: "![High](https://example.com/h.svg)\nUse this:\n```ts\nconst a = 1;\n```",
        }).issue;

        expect(issue).toBe("Use this:\n```ts\nconst a = 1;\n```");
    });

    test("a suggestion block is the suggested code, with Windows line endings too", () => {
        expect(parseOne({ body: "Try:\n```suggestion\nconst a = 2;\n```" }).suggestedCode).toBe("const a = 2;\n");
        expect(parseOne({ body: "Try:\r\n```suggestion\r\nconst a = 2;\r\n```" }).suggestedCode).toBe(
            "const a = 2;\r\n"
        );
    });

    test("a plain code block counts as a suggestion only when the comment says should or instead", () => {
        const block = "```ts\nconst a = 3;\n```";

        expect(parseOne({ body: `You should write:\n${block}` }).suggestedCode).toBe("const a = 3;\n");
        expect(parseOne({ body: `Instead use:\n${block}` }).suggestedCode).toBe("const a = 3;\n");
        expect(parseOne({ body: `For reference:\n${block}` }).suggestedCode).toBeNull();
        expect(parseOne({ body: "no code here" }).suggestedCode).toBeNull();
    });

    describe("diff hunk trimming", () => {
        const context = (from: number, to: number): string[] =>
            Array.from({ length: to - from + 1 }, (_, i) => ` l${from + i}`);

        test("keeps three lines of context around the commented line and rewrites the header", () => {
            const diffHunk = ["@@ -1,12 +1,12 @@", ...context(1, 12)].join("\n");

            expect(parseOne({ diffHunk, line: 6 }).diffHunk).toBe(["@@ -3,7 +3,7 @@", ...context(3, 9)].join("\n"));
        });

        test("a multi-line comment keeps its whole range plus context", () => {
            const diffHunk = ["@@ -1,12 +1,12 @@", ...context(1, 12)].join("\n");

            expect(parseOne({ diffHunk, startLine: 5, line: 6 }).diffHunk).toBe(
                ["@@ -2,8 +2,8 @@", ...context(2, 9)].join("\n")
            );
        });

        test("counts removed lines in the old size only and added lines in the new size only", () => {
            const diffHunk = "@@ -1,9 +1,9 @@\n a\n-b\n+B\n c\n d";

            expect(parseOne({ diffHunk, line: 2 }).diffHunk).toBe("@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n d");
            expect(parseOne({ diffHunk: "@@ -1,3 +1,2 @@\n a\n-b\n c", line: 1 }).diffHunk).toBe(
                "@@ -1,3 +1,2 @@\n a\n-b\n c"
            );
            expect(parseOne({ diffHunk: "@@ -1 +1,2 @@\n a\n+b", line: 2 }).diffHunk).toBe("@@ -1,1 +1,2 @@\n a\n+b");
        });

        test("never keeps more than fifteen lines, centred on the commented line", () => {
            const diffHunk = ["@@ -1,40 +1,40 @@", ...context(1, 40)].join("\n");

            expect(parseOne({ diffHunk, startLine: 1, line: 20 }).diffHunk).toBe(
                ["@@ -9,15 +9,15 @@", ...context(9, 23)].join("\n")
            );
        });

        test("keeps the last fifteen lines when the commented line is not in the hunk", () => {
            const diffHunk = ["@@ -1,30 +1,30 @@", ...context(1, 30)].join("\n");

            expect(parseOne({ diffHunk, startLine: 1, line: 50 }).diffHunk).toBe(
                ["@@ -16,15 +16,15 @@", ...context(16, 30)].join("\n")
            );
        });

        test("leaves the hunk alone with no target line, no header, or a window outside the hunk", () => {
            const diffHunk = ["@@ -1,12 +1,12 @@", ...context(1, 12)].join("\n");

            expect(parseOne({ diffHunk, line: null }).diffHunk).toBe(diffHunk);
            expect(parseOne({ diffHunk: "no header\n x", line: 3 }).diffHunk).toBe("no header\n x");
            expect(parseOne({ diffHunk, line: 100 }).diffHunk).toBe(diffHunk);
        });
    });
});

describe("calculateReviewStats", () => {
    test("counts resolved, unresolved and each severity", () => {
        const threads = [
            parseOne({ id: "T1", body: "critical" }),
            { ...parseOne({ id: "T2", body: "refactor" }), status: "resolved" as const },
            parseOne({ id: "T3", body: "fine" }),
            parseOne({ id: "T4", body: "a bug" }),
        ];

        expect(calculateReviewStats(threads)).toEqual({
            total: 4,
            resolved: 1,
            unresolved: 3,
            high: 2,
            medium: 1,
            low: 1,
        });
    });

    test("no threads gives all zeros", () => {
        expect(calculateReviewStats([])).toEqual({ total: 0, resolved: 0, unresolved: 0, high: 0, medium: 0, low: 0 });
    });
});
