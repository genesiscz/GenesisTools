import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realOctokit from "@genesiscz/utils/github/octokit";

type GraphqlCall = { query: string; variables: Record<string, unknown> };

let writeCalls: GraphqlCall[] = [];
let writeFailure: Error | null = null;

const writeClient = {
    graphql: async (query: string, variables: Record<string, unknown>) => {
        writeCalls.push({ query, variables });

        if (writeFailure) {
            throw writeFailure;
        }

        if (query.includes("addPullRequestReviewThreadReply")) {
            return { addPullRequestReviewThreadReply: { comment: { id: "comment-1" } } };
        }

        return { resolveReviewThread: { thread: { isResolved: true } } };
    },
};

// The read client carries the env token, a fine-grained PAT that may not see the repository at all
// (a transferred repo answers NOT_FOUND), and withGhFallback retries reads only. It throws, so a
// write that reaches it fails loudly instead of passing quietly.
const readClient = {
    graphql: async () => {
        throw new Error("a write went through the env-token read client");
    },
};

mock.module("@genesiscz/utils/github/octokit", () => ({
    ...realOctokit,
    getOctokit: () => readClient,
    getOctokitForWrite: () => writeClient,
    getGhCliToken: () => undefined,
}));

const { batchReply, batchReplyAndResolve, batchResolveThreads, markThreadResolved, replyToThread } = await import(
    "./review-threads"
);

beforeEach(() => {
    writeCalls = [];
    writeFailure = null;
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
