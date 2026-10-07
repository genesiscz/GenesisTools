import { afterEach, describe, expect, it, test } from "bun:test";
import type { AIEmbeddingProvider, AITask, EmbeddingResult } from "../types";
import { Embedder } from "./Embedder";

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

describe("Embedder batch logic (through Embedder class)", () => {
    // Helper to create Embedder from a provider (bypasses AIConfig)
    function createEmbedderFromProvider(provider: AIEmbeddingProvider): Embedder {
        return new (Embedder as unknown as new (p: AIEmbeddingProvider) => Embedder)(provider);
    }

    test("embedBatch uses native batch when provider supports it", async () => {
        const provider = createBatchMockProvider(768);
        const emb = createEmbedderFromProvider(provider);

        const results = await emb.embedBatch(["hello", "world", "test"]);

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["batch:3"]);
        emb.dispose();
    });

    test("embedBatch falls back to individual embed() for non-batch providers", async () => {
        const provider = createSequentialMockProvider(384);
        const emb = createEmbedderFromProvider(provider);

        const results = await emb.embedBatch(["a", "b", "c"]);

        expect(results).toHaveLength(3);
        expect(provider.callLog).toEqual(["embed:a", "embed:b", "embed:c"]);
        emb.dispose();
    });

    test("empty input returns empty array", async () => {
        const provider = createBatchMockProvider(768);
        const emb = createEmbedderFromProvider(provider);

        const results = await emb.embedBatch([]);

        expect(results).toHaveLength(0);
        emb.dispose();
    });

    test("the model the embedder was created for reaches every provider call, and a per-call model wins", async () => {
        const seen: Array<string | undefined> = [];
        const provider: AIEmbeddingProvider = {
            ...createBatchMockProvider(4),
            async embed(_text, options) {
                seen.push(options?.model);
                return { vector: new Float32Array(4), dimensions: 4 };
            },
            async embedBatch(texts, options) {
                seen.push(options?.model);
                return texts.map(() => ({ vector: new Float32Array(4), dimensions: 4 }));
            },
        };
        const emb = new (Embedder as unknown as new (p: AIEmbeddingProvider, model?: string) => Embedder)(
            provider,
            "custom-model"
        );

        await emb.embed("a");
        await emb.embedBatch(["b"]);
        await emb.embed("c", { model: "explicit" });

        expect(seen).toEqual(["custom-model", "custom-model", "explicit"]);
        emb.dispose();
    });

    test("supportsBatch reflects provider capability", () => {
        const batch = createEmbedderFromProvider(createBatchMockProvider(768));
        const seq = createEmbedderFromProvider(createSequentialMockProvider(384));

        expect(batch.supportsBatch).toBe(true);
        expect(seq.supportsBatch).toBe(false);

        batch.dispose();
        seq.dispose();
    });
});
