import { describe, expect, test } from "bun:test";
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

    test("accepts custom baseUrl and model", () => {
        const provider = new AIOllamaProvider({
            baseUrl: "http://custom-host:9999",
            defaultModel: "mxbai-embed-large",
        });

        expect(provider.type).toBe("ollama");
        expect(typeof provider.embed).toBe("function");
        expect(typeof provider.embedBatch).toBe("function");
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
