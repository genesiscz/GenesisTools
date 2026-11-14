import { afterEach, expect, mock, test } from "bun:test";

const lookups: string[] = [];

mock.module("@genesiscz/utils/ai/github-copilot/token", () => ({
    clearSessionCache: () => {},
    getCopilotSession: async () => ({ token: "session-fixture", apiBaseUrl: "https://copilot.example.test" }),
    resolveGithubCopilotGhoToken: async () => {
        lookups.push("gho");
        throw new Error("fixture: a cancelled request must not look up credentials");
    },
}));

const { GithubCopilotApi } = await import("./api");
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    lookups.length = 0;
});

test("a request cancelled as its 401 arrives looks up no credentials", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_input: string | URL | Request) => {
        controller.abort();
        return new Response("no", { status: 401 });
    }) as typeof fetch;

    const api = new GithubCopilotApi({ dataDir: "/fixture/copilot" });

    await expect(api.fetch("/chat/completions", { method: "POST", signal: controller.signal })).rejects.toThrow();
    expect(lookups).toEqual([]);
});
