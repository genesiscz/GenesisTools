import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SafeJSON } from "@app/utils/json";

interface FetchCall {
    url: string;
    init: RequestInit;
}

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

function installEnv(config: Record<string, unknown>): FetchCall[] {
    const calls: FetchCall[] = [];
    const store = { ...config };

    globalThis.chrome = {
        runtime: {
            onConnect: { addListener: () => {} },
            onMessage: { addListener: () => {} },
        },
        storage: {
            local: {
                get: async (keys: string | string[]) => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    const result: Record<string, unknown> = {};
                    for (const key of list) {
                        result[key] = store[key];
                    }
                    return result;
                },
                set: async () => {},
                remove: async () => {},
            },
        },
    } as unknown as typeof chrome;

    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        return new Response(SafeJSON.stringify({ ok: true }, { strict: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;

    // background.ts opens the events WebSocket at import time; stub it so the
    // module loads under bun's test runtime (no DOM / WebSocket global).
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
        onopen: (() => void) | null = null;
        onmessage: ((event: unknown) => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
    };

    return calls;
}

async function loadHandleRequest() {
    const module = await import("@ext/background");
    return module.handleRequest;
}

describe("extension background request routing", () => {
    beforeEach(() => {
        installEnv({ apiBaseUrl: "http://localhost:9876" });
    });

    afterEach(() => {
        globalThis.chrome = originalChrome;
        globalThis.fetch = originalFetch;
        (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    });

    it("builds the channel videos URL for api:listVideos", async () => {
        const calls = installEnv({ apiBaseUrl: "http://localhost:9876" });
        const handleRequest = await loadHandleRequest();

        const res = await handleRequest({ type: "api:listVideos", channel: "@mkbhd", limit: 20, includeShorts: true });

        expect(res.ok).toBe(true);
        expect(calls.at(-1)?.url).toBe(
            "http://localhost:9876/api/v1/videos?channel=%40mkbhd&limit=20&includeShorts=true"
        );
        expect(calls.at(-1)?.init.method ?? "GET").toBe("GET");
    });

    it("omits absent optional params for api:listVideos", async () => {
        const calls = installEnv({ apiBaseUrl: "http://localhost:9876" });
        const handleRequest = await loadHandleRequest();

        await handleRequest({ type: "api:listVideos" });

        expect(calls.at(-1)?.url).toBe("http://localhost:9876/api/v1/videos");
    });

    it("attaches a bearer token when a service key is configured", async () => {
        const calls = installEnv({ apiBaseUrl: "https://vps.example.com/yt", serviceKey: "alice-key" });
        const handleRequest = await loadHandleRequest();

        await handleRequest({ type: "api:listVideos", channel: "@mkbhd" });

        const auth = new Headers(calls.at(-1)?.init.headers).get("Authorization");
        expect(auth).toBe("Bearer alice-key");
    });

    it("forwards long mode + tone/format/length to the generateSummary POST body", async () => {
        const calls = installEnv({ apiBaseUrl: "http://localhost:9876" });
        const handleRequest = await loadHandleRequest();

        await handleRequest({
            type: "api:generateSummary",
            id: "vid123",
            mode: "long",
            tone: "funny",
            format: "qa",
            length: "detailed",
        });

        const call = calls.at(-1);
        expect(call?.url).toBe("http://localhost:9876/api/v1/videos/vid123/summary");
        expect(call?.init.method).toBe("POST");

        const body = SafeJSON.parse(String(call?.init.body)) as Record<string, unknown>;
        expect(body.mode).toBe("long");
        expect(body.tone).toBe("funny");
        expect(body.format).toBe("qa");
        expect(body.length).toBe("detailed");
    });

    it("forwards long mode as the getSummary GET query param", async () => {
        const calls = installEnv({ apiBaseUrl: "http://localhost:9876" });
        const handleRequest = await loadHandleRequest();

        await handleRequest({ type: "api:getSummary", id: "vid123", mode: "long" });

        expect(calls.at(-1)?.url).toBe("http://localhost:9876/api/v1/videos/vid123/summary?mode=long");
    });

    it("forwards lang on generateSummary (Feature 08)", async () => {
        const calls = installEnv({ apiBaseUrl: "http://localhost:9876" });
        const handleRequest = await loadHandleRequest();

        await handleRequest({ type: "api:generateSummary", id: "vid123", mode: "short", lang: "cs" });

        const body = SafeJSON.parse(String(calls.at(-1)?.init.body)) as Record<string, unknown>;
        expect(body.lang).toBe("cs");
    });

    it("posts translateTranscript to the transcript/translate route", async () => {
        const calls = installEnv({ apiBaseUrl: "http://localhost:9876" });
        const handleRequest = await loadHandleRequest();

        await handleRequest({ type: "api:translateTranscript", id: "vid123", lang: "cs" });

        const call = calls.at(-1);
        expect(call?.url).toBe("http://localhost:9876/api/v1/videos/vid123/transcript/translate");
        expect(call?.init.method).toBe("POST");
        const body = SafeJSON.parse(String(call?.init.body)) as Record<string, unknown>;
        expect(body.lang).toBe("cs");
    });

    it("PATCHes patchMe to users/me with outputLang/ttsVoice", async () => {
        const calls = installEnv({ apiBaseUrl: "http://localhost:9876" });
        const handleRequest = await loadHandleRequest();

        await handleRequest({ type: "api:patchMe", outputLang: "cs", ttsVoice: "alloy" });

        const call = calls.at(-1);
        expect(call?.url).toBe("http://localhost:9876/api/v1/users/me");
        expect(call?.init.method).toBe("PATCH");
        const body = SafeJSON.parse(String(call?.init.body)) as Record<string, unknown>;
        expect(body.outputLang).toBe("cs");
        expect(body.ttsVoice).toBe("alloy");
    });
});
