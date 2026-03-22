import { describe, expect, it, mock } from "bun:test";
import type { QdrantClientLike } from "./qdrant-vector-store";
import { QdrantVectorStore } from "./qdrant-vector-store";

/** In-memory mock of Qdrant client for unit testing */
function createMockQdrantClient(): QdrantClientLike & {
    _points: Map<string, { id: string; vector: number[]; payload: Record<string, unknown> }>;
} {
    const points = new Map<string, { id: string; vector: number[]; payload: Record<string, unknown> }>();

    return {
        getCollections: mock(async () => ({
            collections: [] as Array<{ name: string }>,
        })),

        createCollection: mock(async () => {}),

        upsert: mock(
            async (
                _collection: string,
                opts: {
                    points: Array<{
                        id: string;
                        vector: Record<string, number[]>;
                        payload?: Record<string, unknown>;
                    }>;
                }
            ) => {
                for (const p of opts.points) {
                    const vec = p.vector.dense ?? Object.values(p.vector)[0];
                    points.set(p.id, { id: p.id, vector: vec, payload: p.payload ?? {} });
                }
            }
        ),

        delete: mock(async (_collection: string, opts: { points: string[] }) => {
            for (const id of opts.points) {
                points.delete(id);
            }
        }),

        search: mock(
            async (
                _collection: string,
                opts: {
                    vector: { name: string; vector: number[] };
                    limit: number;
                }
            ) => {
                const queryVec = opts.vector.vector;
                const scored = [...points.values()].map((p) => {
                    let dot = 0;
                    let normA = 0;
                    let normB = 0;

                    for (let i = 0; i < queryVec.length; i++) {
                        dot += queryVec[i] * p.vector[i];
                        normA += queryVec[i] * queryVec[i];
                        normB += p.vector[i] * p.vector[i];
                    }

                    const denom = Math.sqrt(normA) * Math.sqrt(normB);
                    const score = denom === 0 ? 0 : dot / denom;
                    return { id: p.id, score, payload: p.payload };
                });

                scored.sort((a, b) => b.score - a.score);
                return scored.slice(0, opts.limit);
            }
        ),

        query: mock(async (_collection: string, opts: { limit: number }) => {
            const scored = [...points.values()].map((p) => ({
                id: p.id,
                score: 1.0,
                payload: p.payload,
            }));

            return { points: scored.slice(0, opts.limit) };
        }),

        count: mock(async () => ({
            count: points.size,
        })),

        _points: points,
    };
}

describe("QdrantVectorStore", () => {
    it("stores and searches vectors via in-memory mirror", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        store.store("c", new Float32Array([0.9, 0.1, 0]));

        // Synchronous search uses in-memory mirror
        const results = store.search(new Float32Array([1, 0, 0]), 3);
        expect(results[0].docId).toBe("a");
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it("removes vectors", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        store.remove("a");

        const results = store.search(new Float32Array([1, 0, 0]), 10);
        expect(results.length).toBe(0);
    });

    it("returns count of stored vectors", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient,
        });

        await store.init();

        expect(store.count()).toBe(0);

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));
        expect(store.count()).toBe(2);
    });

    it("flushes pending operations to the remote client", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        await store.flush();

        expect(mockClient.upsert).toHaveBeenCalled();
        expect(mockClient._points.size).toBe(1);
    });

    it("searchAsync queries the remote client after flush", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "test",
            dimensions: 3,
            client: mockClient,
        });

        await store.init();

        store.store("a", new Float32Array([1, 0, 0]));
        store.store("b", new Float32Array([0, 1, 0]));

        const results = await store.searchAsync(new Float32Array([1, 0, 0]), 2);
        expect(results.length).toBe(2);
        expect(results[0].docId).toBe("a");
    });
});

describe("QdrantVectorStore — hybrid search scenarios", () => {
    it("finds semantically similar vectors with cosine similarity", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "hybrid",
            dimensions: 4,
            client: mockClient,
        });

        await store.init();

        // Cluster 1: "code" vectors
        store.store("code1", new Float32Array([0.9, 0.1, 0.0, 0.0]));
        store.store("code2", new Float32Array([0.8, 0.2, 0.0, 0.0]));

        // Cluster 2: "docs" vectors
        store.store("doc1", new Float32Array([0.0, 0.0, 0.9, 0.1]));
        store.store("doc2", new Float32Array([0.0, 0.0, 0.8, 0.2]));

        // Query close to "code" cluster
        const codeResults = store.search(new Float32Array([1.0, 0.0, 0.0, 0.0]), 4);
        expect(codeResults[0].docId).toBe("code1");
        expect(codeResults[1].docId).toBe("code2");

        // Query close to "docs" cluster
        const docResults = store.search(new Float32Array([0.0, 0.0, 1.0, 0.0]), 4);
        expect(docResults[0].docId).toBe("doc1");
        expect(docResults[1].docId).toBe("doc2");
    });

    it("handles batch upsert and removal correctly", async () => {
        const mockClient = createMockQdrantClient();
        const store = new QdrantVectorStore({
            collectionName: "batch",
            dimensions: 2,
            client: mockClient,
        });

        await store.init();

        // Add many vectors
        for (let i = 0; i < 50; i++) {
            store.store(`vec${i}`, new Float32Array([Math.cos(i), Math.sin(i)]));
        }

        expect(store.count()).toBe(50);

        // Remove half
        for (let i = 0; i < 25; i++) {
            store.remove(`vec${i}`);
        }

        expect(store.count()).toBe(25);

        // Search should only find remaining vectors
        const results = store.search(new Float32Array([1, 0]), 10);

        for (const r of results) {
            const idx = Number.parseInt(r.docId.replace("vec", ""), 10);
            expect(idx).toBeGreaterThanOrEqual(25);
        }
    });
});
