import { afterEach, describe, expect, test } from "bun:test";
import {
    hasValidLongLivedToken,
    LONG_TOKEN_MIN_LENGTH,
    probeLongLivedToken,
    verifyLongLivedToken,
} from "./token-verify";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = impl as typeof fetch;
}

describe("hasValidLongLivedToken", () => {
    test("absent token is not valid", () => {
        expect(hasValidLongLivedToken({})).toBe(false);
    });

    test("a truncated paste is treated as absent", () => {
        expect(hasValidLongLivedToken({ longLivedToken: `sk-ant-oat01-${"x".repeat(40)}` })).toBe(false);
    });

    test("a full-length token is valid", () => {
        expect(hasValidLongLivedToken({ longLivedToken: "x".repeat(LONG_TOKEN_MIN_LENGTH) })).toBe(true);
    });
});

describe("verifyLongLivedToken", () => {
    test("2xx is ok", async () => {
        stubFetch(async () => new Response("{}", { status: 200 }));
        expect(await verifyLongLivedToken("tok")).toBe("ok");
    });

    test("401 is invalid", async () => {
        stubFetch(async () => new Response("nope", { status: 401 }));
        expect(await verifyLongLivedToken("tok")).toBe("invalid");
    });

    test("403 is invalid", async () => {
        stubFetch(async () => new Response("nope", { status: 403 }));
        expect(await verifyLongLivedToken("tok")).toBe("invalid");
    });

    test("429 is limited — authenticated, just throttled", async () => {
        stubFetch(async () => new Response("slow down", { status: 429 }));
        expect(await verifyLongLivedToken("tok")).toBe("limited");
    });

    test("an unexpected 4xx (retired probe model) degrades to unreachable, never invalid", async () => {
        stubFetch(async () => new Response('{"error":"model not found"}', { status: 404 }));
        expect(await verifyLongLivedToken("tok")).toBe("unreachable");
    });

    test("a 5xx degrades to unreachable", async () => {
        stubFetch(async () => new Response("boom", { status: 503 }));
        expect(await verifyLongLivedToken("tok")).toBe("unreachable");
    });

    test("a rejected fetch (offline, timeout) is unreachable", async () => {
        stubFetch(async () => {
            throw new Error("network down");
        });
        expect(await verifyLongLivedToken("tok")).toBe("unreachable");
    });

    test("sends the claude-cli user agent and an abort signal", async () => {
        let seen: RequestInit | undefined;
        stubFetch(async (_input, init) => {
            seen = init;
            return new Response("{}", { status: 200 });
        });

        await verifyLongLivedToken("tok");

        const headers = seen?.headers as Record<string, string>;
        expect(headers["user-agent"]).toContain("claude-cli");
        expect(headers.authorization).toBe("Bearer tok");
        expect(seen?.signal).toBeDefined();
    });
});

describe("probeLongLivedToken", () => {
    function recordingFetch(status: number): Array<{ url: string; method: string; body: unknown }> {
        const calls: Array<{ url: string; method: string; body: unknown }> = [];
        stubFetch(async (input, init) => {
            calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
            return new Response("{}", { status });
        });

        return calls;
    }

    // The point of this probe: a diagnostic must not spend quota or create
    // provider-side history. A GET with no body cannot.
    test("reads the profile endpoint with GET and sends no request body", async () => {
        const calls = recordingFetch(200);

        expect(await probeLongLivedToken("tok")).toBe("ok");
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://api.anthropic.com/api/oauth/profile");
        expect(calls[0].method).toBe("GET");
        expect(calls[0].body).toBeUndefined();
        expect(calls[0].url).not.toContain("/v1/messages");
    });

    test("401 and 403 are invalid", async () => {
        stubFetch(async () => new Response("", { status: 401 }));
        expect(await probeLongLivedToken("tok")).toBe("invalid");

        stubFetch(async () => new Response("", { status: 403 }));
        expect(await probeLongLivedToken("tok")).toBe("invalid");
    });

    test("429 is authenticated but limited", async () => {
        stubFetch(async () => new Response("", { status: 429 }));
        expect(await probeLongLivedToken("tok")).toBe("limited");
    });

    test("any other non-ok status is unreachable, not an auth verdict", async () => {
        stubFetch(async () => new Response("", { status: 500 }));
        expect(await probeLongLivedToken("tok")).toBe("unreachable");
    });

    test("a network failure is unreachable", async () => {
        stubFetch(async () => {
            throw new Error("ECONNREFUSED");
        });
        expect(await probeLongLivedToken("tok")).toBe("unreachable");
    });

    // Negative control: capture-time verification is SUPPOSED to bill one token,
    // so the read-only probe must not have replaced it everywhere.
    test("verifyLongLivedToken still posts to the inference endpoint", async () => {
        const calls: Array<{ url: string; method: string }> = [];
        stubFetch(async (input, init) => {
            calls.push({ url: String(input), method: init?.method ?? "GET" });
            return new Response("{}", { status: 200 });
        });

        expect(await verifyLongLivedToken("tok")).toBe("ok");
        expect(calls[0]).toEqual({ url: "https://api.anthropic.com/v1/messages", method: "POST" });
    });
});
