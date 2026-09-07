import { afterEach, describe, expect, mock, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { NETWORKED_LOCK_WAIT_MS } from "@genesiscz/utils/storage/file-lock";

// `resolveCodexAccountToken` refreshes INSIDE the AI config lock, the same
// physical lock file the anthropic refresh takes. This pins the wait budget it
// asks for: the plain 5 s default meant a sibling provider's in-flight refresh
// could time codex out for contention codex did not cause.

interface FakeTokens {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
}

let tokens: FakeTokens = {};
const lockTimeouts: Array<number | undefined> = [];

mock.module("../AIConfig", () => ({
    AIConfig: {
        load: async () => ({
            getAccount: (name: string) =>
                name === "work" ? { name, provider: "openai-sub", tokens: { ...tokens } } : undefined,
            withLock: async (fn: (data: unknown) => Promise<string>, timeout?: number) => {
                lockTimeouts.push(timeout);

                return fn({ accounts: [{ name: "work", provider: "openai-sub", tokens }] });
            },
        }),
    },
}));

import { resolveCodexAccountToken } from "./codex-auth";

function jwt(payload: Record<string, unknown>): string {
    return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(SafeJSON.stringify(payload)).toString("base64url")}.signature`;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    lockTimeouts.length = 0;
});

describe("resolveCodexAccountToken lock budget", () => {
    test("asks for the networked wait budget, not the plain config-edit default", async () => {
        tokens = { accessToken: jwt({}), refreshToken: "rt-1", expiresAt: Date.now() - 1_000 };
        globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response(SafeJSON.stringify({ access_token: jwt({}), refresh_token: "rt-2", expires_in: 3600 }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            })) as typeof fetch;

        await resolveCodexAccountToken("work");

        expect(lockTimeouts).toEqual([NETWORKED_LOCK_WAIT_MS]);
    });

    test("a token that is still fresh never takes the lock at all", async () => {
        // Negative control: the budget change must not drag every read through
        // the lock, which would serialise reads behind any in-flight refresh.
        tokens = { accessToken: jwt({}), refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 };
        globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
            throw new Error("the fresh path must not reach the network");
        }) as typeof fetch;

        await resolveCodexAccountToken("work");

        expect(lockTimeouts).toEqual([]);
    });
});
