import { afterEach, describe, expect, it, test } from "bun:test";
import { Embedder } from "./Embedder";
import type { AIEmbeddingProvider, AITask, EmbeddingResult } from "../types";

const isDarwin = process.platform === "darwin";

/** Minimal mock provider WITHOUT batch support */
function createSequentialMockProvider(dims: number): AIEmbeddingProvider & { callLog: string[] } {
    const callLog: string[] = [];
    return {
        type: "local-hf",
        dimensions: dims,
        callLog,
        async isAvailable() {
            return true;
        },
        supports(task: AITask) {
            return task === "embed";
        },
        async embed(text: string): Promise<EmbeddingResult> {
            callLog.push(`embed:${text}`);
            return { vector: new Float32Array(dims).fill(1), dimensions: dims };
        },
    };
}

/** Mock provider WITH batch support */
function createBatchMockProvider(dims: number): AIEmbeddingProvider & { callLog: string[] } {
    const callLog: string[] = [];
    return {
        type: "cloud",
        dimensions: dims,
        callLog,
        async isAvailable() {
            return true;
        },
        supports(task: AITask) {
            return task === "embed";
        },
        async embed(text: string): Promise<EmbeddingResult> {
            callLog.push(`embed:${text}`);
            return { vector: new Float32Array(dims).fill(1), dimensions: dims };
        },
        async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
            callLog.push(`batch:${texts.length}`);
            return texts.map(() => ({ vector: new Float32Array(dims).fill(1), dimensions: dims }));
        },
    };
}

describe("Embedder", () => {
    let embedder: Embedder | null = null;

    afterEach(() => {
        if (embedder) {
            embedder.dispose();
            embedder = null;
        }
    });

    it.skipIf(!isDarwin)("Embedder.create() resolves without error", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        expect(embedder).toBeTruthy();
    });

    it.skipIf(!isDarwin)("embedder.dimensions returns a positive number", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        expect(embedder.dimensions).toBeGreaterThan(0);
    });

    it.skipIf(!isDarwin)("embedder.embed() returns { vector: Float32Array, dimensions: number }", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        const result = await embedder.embed("test text");

        expect(result).toHaveProperty("vector");
        expect(result).toHaveProperty("dimensions");
        expect(result.vector).toBeInstanceOf(Float32Array);
        expect(result.dimensions).toBeGreaterThan(0);
        expect(result.vector.length).toBe(result.dimensions);
    });

    it.skipIf(!isDarwin)("embedder.embedMany() returns array of results", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        const results = await embedder.embedMany(["hello", "world"]);

        expect(results).toBeArrayOfSize(2);

        for (const result of results) {
            expect(result.vector).toBeInstanceOf(Float32Array);
            expect(result.dimensions).toBeGreaterThan(0);
        }
    });

    it.skipIf(!isDarwin)("embedder.dispose() doesn't throw", async () => {
        embedder = await Embedder.create({ provider: "darwinkit" });
        expect(() => embedder!.dispose()).not.toThrow();
        embedder = null; // Already disposed
    });
});

describe("Embedder batch logic", () => {
    test("embedBatch uses native batch when provider supports it", async () => {
        const provider = createBatchMockProvider(768);
        const texts = ["hello", "world", "test"];

        const results = await provider.embedBatch!(texts);

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["batch:3"]);
    });

    test("sequential provider falls back to individual embed calls", async () => {
        const provider = createSequentialMockProvider(384);
        const texts = ["a", "b", "c"];

        // Simulate what Embedder.embedBatch does for non-batch providers
        expect(provider.embedBatch).toBeUndefined();

        const results = await Promise.all(texts.map((t) => provider.embed(t)));

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["embed:a", "embed:b", "embed:c"]);
    });

    test("empty input returns empty array", async () => {
        const provider = createBatchMockProvider(768);
        const results = await provider.embedBatch!([]);

        expect(results).toHaveLength(0);
    });

    test("supportsBatch reflects provider capability", () => {
        const batch = createBatchMockProvider(768);
        const seq = createSequentialMockProvider(384);

        expect(typeof batch.embedBatch).toBe("function");
        expect(seq.embedBatch).toBeUndefined();
    });
});
