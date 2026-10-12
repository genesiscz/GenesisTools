import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realOctokit from "@genesiscz/utils/github/octokit";

const notification = {
    id: "101",
    unread: true,
    reason: "mention",
    updated_at: "2026-10-12T22:00:00Z",
    last_read_at: null,
    subject: {
        title: "Fix the checkout",
        url: "https://api.github.com/repos/shop/storefront/pulls/7",
        latest_comment_url: null,
        type: "PullRequest",
    },
    repository: {
        id: 1,
        full_name: "shop/storefront",
        html_url: "https://github.com/shop/storefront",
        owner: { login: "shop" },
    },
};

let readRoutes: string[] = [];
let writeRoutes: string[] = [];

// The read client carries the env token. A fine-grained PAT cannot use the notifications API at all
// (403 "Resource not accessible by personal access token"), and withGhFallback rescues GETs only.
// Any write that reaches it fails loudly.
const readClient = {
    request: async (route: string) => {
        readRoutes.push(route);

        if (route.startsWith("GET ")) {
            return { data: [notification] };
        }

        throw new Error(`a write went through the env-token read client: ${route}`);
    },
};

const writeClient = {
    request: async (route: string, params: { thread_id: number }) => {
        writeRoutes.push(`${route} ${params.thread_id}`);

        return { status: 204, data: undefined };
    },
};

mock.module("@genesiscz/utils/github/octokit", () => ({
    ...realOctokit,
    getOctokit: () => readClient,
    getOctokitForWrite: () => writeClient,
}));

const { notificationsCommand } = await import("./notifications");

beforeEach(() => {
    readRoutes = [];
    writeRoutes = [];
});

describe("notifications writes", () => {
    test("--mark-read and --mark-done go through the write client, the list through the read client", async () => {
        await notificationsCommand({ markRead: true, markDone: true, format: "json" });

        expect(readRoutes).toEqual(["GET /notifications"]);
        expect(writeRoutes).toEqual([
            "PATCH /notifications/threads/{thread_id} 101",
            "DELETE /notifications/threads/{thread_id} 101",
        ]);
    });

    test("listing alone never touches the write client", async () => {
        await notificationsCommand({ format: "json" });

        expect(readRoutes).toEqual(["GET /notifications"]);
        expect(writeRoutes).toEqual([]);
    });
});
