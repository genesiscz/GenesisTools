import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import { AIOllamaProvider } from "./AIOllamaProvider";

describe("AIOllamaProvider", () => {
    test("has correct type and default dimensions", () => {
        const provider = new AIOllamaProvider();

        expect(provider.type).toBe("ollama");
        expect(provider.dimensions).toBe(768);
    });

    test("supports embed task only", () => {
        const provider = new AIOllamaProvider();

        expect(provider.supports("embed")).toBe(true);
        expect(provider.supports("transcribe")).toBe(false);
        expect(provider.supports("translate")).toBe(false);
        expect(provider.supports("summarize")).toBe(false);
    });

    test("embedBatch returns empty array for empty input", async () => {
        const provider = new AIOllamaProvider();
        const results = await provider.embedBatch([]);

        expect(results).toEqual([]);
    });

    test("embed uses custom baseUrl and model from constructor", async () => {
        const customUrl = "http://custom-host:9999";
        const customModel = "mxbai-embed-large";
        const provider = new AIOllamaProvider({
            baseUrl: customUrl,
            defaultModel: customModel,
        });

        // Stub global fetch to capture the request
        const originalFetch = globalThis.fetch;
        let capturedUrl = "";
        let capturedBody = "";

        // @ts-expect-error -- fetch stub for test
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            capturedUrl = typeof input === "string" ? input : input.toString();
            capturedBody = typeof init?.body === "string" ? init.body : "";

            return new Response(
                SafeJSON.stringify({
                    embeddings: [[0.1, 0.2, 0.3]],
                }),
                { status: 200 }
            );
        };

        try {
            await provider.embed("test text");
            expect(capturedUrl).toBe(`${customUrl}/api/embed`);
            expect(capturedBody).toContain(customModel);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("isAvailable returns false when Ollama not running", async () => {
        const provider = new AIOllamaProvider({
            baseUrl: "http://localhost:99999",
        });
        const available = await provider.isAvailable();

        expect(available).toBe(false);
    });

    // Integration test: only runs if Ollama is available locally
    test.skipIf(!process.env.TEST_OLLAMA)("embed() returns valid vector (requires running Ollama)", async () => {
        const provider = new AIOllamaProvider();
        const result = await provider.embed("Hello, world!");

        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBeGreaterThan(0);
        expect(result.vector.length).toBe(result.dimensions);
    });

    test.skipIf(!process.env.TEST_OLLAMA)("embedBatch() returns correct count (requires running Ollama)", async () => {
        const provider = new AIOllamaProvider();
        const texts = ["Hello", "World", "Test"];
        const results = await provider.embedBatch(texts);

        expect(results).toHaveLength(3);

        for (const result of results) {
            expect(result.vector).toBeInstanceOf(Float32Array);
            expect(result.dimensions).toBeGreaterThan(0);
        }
    });
});
