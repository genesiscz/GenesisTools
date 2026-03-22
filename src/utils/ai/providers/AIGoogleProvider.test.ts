import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { AIGoogleProvider } from "./AIGoogleProvider";

/** Stub globalThis.fetch without TS complaining about the `preconnect` property Bun adds. */
function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
    // @ts-expect-error -- fetch stub for test
    globalThis.fetch = handler;
}

describe("AIGoogleProvider", () => {
    let originalFetch: typeof globalThis.fetch;
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        originalEnv = process.env.GOOGLE_API_KEY;
        process.env.GOOGLE_API_KEY = "test-api-key";
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;

        if (originalEnv !== undefined) {
            process.env.GOOGLE_API_KEY = originalEnv;
        } else {
            delete process.env.GOOGLE_API_KEY;
        }
    });

    test("has correct type and default dimensions", () => {
        const provider = new AIGoogleProvider();
        expect(provider.type).toBe("google");
        expect(provider.dimensions).toBe(3072);
    });

    test("supports embed task only", () => {
        const provider = new AIGoogleProvider();
        expect(provider.supports("embed")).toBe(true);
        expect(provider.supports("transcribe")).toBe(false);
        expect(provider.supports("translate")).toBe(false);
        expect(provider.supports("summarize")).toBe(false);
    });

    test("isAvailable returns true when GOOGLE_API_KEY is set", async () => {
        const provider = new AIGoogleProvider();
        expect(await provider.isAvailable()).toBe(true);
    });

    test("isAvailable returns false when GOOGLE_API_KEY is missing", async () => {
        delete process.env.GOOGLE_API_KEY;
        const provider = new AIGoogleProvider();
        expect(await provider.isAvailable()).toBe(false);
    });

    test("embedBatch returns empty array for empty input", async () => {
        const provider = new AIGoogleProvider();
        const results = await provider.embedBatch([]);
        expect(results).toEqual([]);
    });

    test("embed sends correct request to Google API", async () => {
        let capturedUrl = "";
        let capturedBody = "";

        stubFetch(async (input, init) => {
            capturedUrl = typeof input === "string" ? input : input.toString();
            capturedBody = typeof init?.body === "string" ? init.body : "";
            return new Response(
                SafeJSON.stringify({
                    embeddings: [{ values: [0.1, 0.2, 0.3] }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );
        });

        const provider = new AIGoogleProvider();
        const result = await provider.embed("test text");

        expect(capturedUrl).toContain("generativelanguage.googleapis.com");
        expect(capturedUrl).toContain("gemini-embedding-001");
        expect(capturedUrl).toContain("batchEmbedContents");
        expect(capturedUrl).toContain("key=test-api-key");
        expect(capturedBody).toContain("test text");
        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBe(3);
    });

    test("embedBatch chunks requests when exceeding batch size", async () => {
        let callCount = 0;

        stubFetch(async (_input, init) => {
            callCount++;
            const body = SafeJSON.parse(typeof init?.body === "string" ? init.body : "{}");
            const count = body.requests.length;
            const embeddings = Array.from({ length: count }, () => ({ values: [0.1, 0.2] }));
            return new Response(SafeJSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        // 150 texts should require 2 batch calls (100 + 50)
        const provider = new AIGoogleProvider({ rateLimitMs: 0 });
        const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
        const results = await provider.embedBatch(texts);

        expect(callCount).toBe(2);
        expect(results).toHaveLength(150);
    });

    test("embedBatch pre-truncates long texts", async () => {
        let capturedTexts: string[] = [];

        stubFetch(async (_input, init) => {
            const body = SafeJSON.parse(typeof init?.body === "string" ? init.body : "{}");
            capturedTexts = body.requests.map(
                (r: { content: { parts: Array<{ text: string }> } }) => r.content.parts[0].text
            );
            const embeddings = capturedTexts.map(() => ({ values: [0.1] }));
            return new Response(SafeJSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const provider = new AIGoogleProvider();
        const longText = "x".repeat(20_000); // Exceeds 2048 tokens * 3 chars/token = 6144 chars
        await provider.embedBatch([longText]);

        expect(capturedTexts[0].length).toBeLessThanOrEqual(6144);
    });

    test("embed throws on API error", async () => {
        stubFetch(async () => {
            return new Response(SafeJSON.stringify({ error: { message: "Invalid API key" } }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
            });
        });

        const provider = new AIGoogleProvider();
        await expect(provider.embed("test")).rejects.toThrow();
    });

    test("uses custom model from constructor options", async () => {
        let capturedUrl = "";

        stubFetch(async (input) => {
            capturedUrl = typeof input === "string" ? input : input.toString();
            return new Response(
                SafeJSON.stringify({
                    embeddings: [{ values: [0.1] }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
            );
        });

        const provider = new AIGoogleProvider({ model: "text-embedding-004" });
        await provider.embed("test");

        expect(capturedUrl).toContain("text-embedding-004");
    });

    test("rate limiter does not delay first batch call", async () => {
        stubFetch(async () => {
            const embeddings = Array.from({ length: 1 }, () => ({ values: [0.1] }));
            return new Response(SafeJSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const provider = new AIGoogleProvider();

        const start = Date.now();
        await provider.embedBatch(["text"]);
        const duration = Date.now() - start;

        // First call should be fast (no rate limit wait)
        expect(duration).toBeLessThan(2000);
    });

    test("embedBatch handles exactly GOOGLE_BATCH_SIZE texts in one call", async () => {
        let callCount = 0;

        stubFetch(async (_input, init) => {
            callCount++;
            const body = SafeJSON.parse(typeof init?.body === "string" ? init.body : "{}");
            const count = body.requests.length;
            const embeddings = Array.from({ length: count }, () => ({ values: [0.1, 0.2] }));
            return new Response(SafeJSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const provider = new AIGoogleProvider();
        const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);
        const results = await provider.embedBatch(texts);

        expect(callCount).toBe(1); // Exactly 100 = one batch
        expect(results).toHaveLength(100);
    });

    test("embedBatch preserves text order across batches", async () => {
        const receivedBatches: string[][] = [];

        stubFetch(async (_input, init) => {
            const body = SafeJSON.parse(typeof init?.body === "string" ? init.body : "{}");
            const texts = body.requests.map(
                (r: { content: { parts: Array<{ text: string }> } }) => r.content.parts[0].text
            );
            receivedBatches.push(texts);
            const embeddings = texts.map((_: string, i: number) => ({
                values: [i * 0.01],
            }));
            return new Response(SafeJSON.stringify({ embeddings }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });

        const provider = new AIGoogleProvider({ rateLimitMs: 0 });
        const texts = Array.from({ length: 250 }, (_, i) => `ordered-${i}`);
        const results = await provider.embedBatch(texts);

        // Should have made 3 calls: 100, 100, 50
        expect(receivedBatches).toHaveLength(3);
        expect(receivedBatches[0]).toHaveLength(100);
        expect(receivedBatches[1]).toHaveLength(100);
        expect(receivedBatches[2]).toHaveLength(50);

        // First batch starts with ordered-0
        expect(receivedBatches[0][0]).toBe("ordered-0");
        // Second batch starts with ordered-100
        expect(receivedBatches[1][0]).toBe("ordered-100");
        // Third batch starts with ordered-200
        expect(receivedBatches[2][0]).toBe("ordered-200");

        expect(results).toHaveLength(250);
    });

    test("embed API error includes status and response body", async () => {
        stubFetch(async () => {
            return new Response(SafeJSON.stringify({ error: { message: "Quota exceeded", code: 429 } }), {
                status: 429,
                statusText: "Too Many Requests",
            });
        });

        const provider = new AIGoogleProvider();

        try {
            await provider.embed("test");
            expect.unreachable("should have thrown");
        } catch (err) {
            const message = (err as Error).message;
            expect(message).toContain("429");
            expect(message).toContain("Quota exceeded");
        }
    });

    test.skipIf(!process.env.TEST_GOOGLE)("embed() returns valid vector (requires GOOGLE_API_KEY)", async () => {
        const provider = new AIGoogleProvider();
        const result = await provider.embed("Hello, world!");

        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBe(3072);
        expect(result.vector.length).toBe(3072);
    });
});
