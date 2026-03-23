import { AsyncOpQueue } from "@app/utils/async";
import { bruteForceVectorSearch, type VectorSearchHit, type VectorStore } from "./vector-store";

export interface QdrantClientLike {
    getCollections(): Promise<{ collections: Array<{ name: string }> }>;
    createCollection(name: string, params: unknown): Promise<void>;
    upsert(
        collection: string,
        opts: {
            points: Array<{
                id: string;
                vector: Record<string, unknown>;
                payload?: Record<string, unknown>;
            }>;
        }
    ): Promise<void>;
    delete(collection: string, opts: { points: string[] }): Promise<void>;
    search(
        collection: string,
        opts: {
            vector: { name: string; vector: number[] };
            limit: number;
            with_payload?: boolean;
        }
    ): Promise<Array<{ id: string; score: number; payload?: Record<string, unknown> }>>;
    query(
        collection: string,
        opts: {
            prefetch: Array<{
                query: number[] | { text: string; model: string };
                using: string;
                limit: number;
                filter?: Record<string, unknown>;
            }>;
            query: { fusion: string };
            limit: number;
            with_payload?: boolean;
            filter?: Record<string, unknown>;
        }
    ): Promise<{ points: Array<{ id: string; score: number; payload?: Record<string, unknown> }> }>;
    count(collection: string): Promise<{ count: number }>;
}

export interface QdrantVectorStoreConfig {
    /** Qdrant collection name */
    collectionName: string;
    /** Vector dimensions */
    dimensions: number;
    /** Pre-constructed Qdrant client (allows caller to manage connection) */
    client?: QdrantClientLike;
    /** Qdrant server URL (used if client not provided) */
    url?: string;
    /** Qdrant API key (used if client not provided) */
    apiKey?: string;
    /** Dense vector name in the collection schema. Default: "dense" */
    vectorName?: string;
}

/**
 * VectorStore backed by Qdrant -- a dedicated vector search engine.
 *
 * Like LanceDBVectorStore, this adapter maintains an in-memory mirror
 * for synchronous search (VectorStore interface is sync), while async
 * operations (upsert/delete) are queued and flushed in the background.
 *
 * For full Qdrant-native hybrid search (dense + BM25 + server-side RRF),
 * use the dedicated `searchHybridAsync()` method which bypasses the
 * VectorStore interface.
 */
export class QdrantVectorStore implements VectorStore {
    private config: QdrantVectorStoreConfig;
    private client: QdrantClientLike | null = null;
    private vectorName: string;
    private memoryIndex = new Map<string, Float32Array>();
    private queue = new AsyncOpQueue("QdrantVectorStore");
    private closed = false;

    constructor(config: QdrantVectorStoreConfig) {
        this.config = config;
        this.vectorName = config.vectorName ?? "dense";

        if (config.client) {
            this.client = config.client;
        }
    }

    /**
     * Initialize: connect to Qdrant and ensure collection exists.
     * Must be called before store/search/remove.
     */
    async init(): Promise<void> {
        if (!this.client) {
            const { QdrantClient } = await import("@qdrant/js-client-rest");
            this.client = new QdrantClient({
                url: this.config.url ?? "http://localhost:6333",
                apiKey: this.config.apiKey,
            }) as unknown as QdrantClientLike;
        }

        await this.ensureCollection();
    }

    store(id: string, vector: Float32Array): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.set(id, new Float32Array(vector));

        this.queue.enqueue(async () => {
            await this.client!.upsert(this.config.collectionName, {
                points: [
                    {
                        id,
                        vector: { [this.vectorName]: Array.from(vector) },
                    },
                ],
            });
        });
    }

    /**
     * Store a vector with associated text for BM25 sparse indexing.
     * Use this instead of store() when you want hybrid search capability.
     */
    storeWithText(id: string, vector: Float32Array, text: string): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.set(id, new Float32Array(vector));

        this.queue.enqueue(async () => {
            await this.client!.upsert(this.config.collectionName, {
                points: [
                    {
                        id,
                        vector: {
                            [this.vectorName]: Array.from(vector),
                            bm25: { text, model: "qdrant/bm25" },
                        },
                        payload: { text },
                    },
                ],
            });
        });
    }

    remove(id: string): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.delete(id);

        this.queue.enqueue(async () => {
            await this.client!.delete(this.config.collectionName, {
                points: [id],
            });
        });
    }

    search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
        return bruteForceVectorSearch(this.memoryIndex, queryVector, limit);
    }

    count(): number {
        return this.memoryIndex.size;
    }

    /**
     * Async search directly against Qdrant server (HNSW ANN).
     */
    async searchAsync(queryVector: Float32Array, limit: number): Promise<VectorSearchHit[]> {
        await this.flush();

        if (!this.client) {
            return [];
        }

        const results = await this.client.search(this.config.collectionName, {
            vector: { name: this.vectorName, vector: Array.from(queryVector) },
            limit,
            with_payload: false,
        });

        return results.map((r) => ({
            docId: String(r.id),
            score: r.score,
        }));
    }

    /**
     * Qdrant-native hybrid search: dense + BM25 with server-side RRF fusion.
     * This is the highest-quality search mode when using Qdrant.
     */
    async searchHybridAsync(opts: {
        queryVector: Float32Array;
        queryText: string;
        limit: number;
        filter?: Record<string, unknown>;
    }): Promise<VectorSearchHit[]> {
        await this.flush();

        if (!this.client) {
            return [];
        }

        const prefetchLimit = Math.max(opts.limit * 3, 30);
        const activeFilter = opts.filter;

        // Use Qdrant query API with prefetch + RRF fusion
        const results = await this.client.query(this.config.collectionName, {
            prefetch: [
                {
                    query: Array.from(opts.queryVector),
                    using: this.vectorName,
                    limit: prefetchLimit,
                    filter: activeFilter,
                },
                {
                    query: { text: opts.queryText, model: "qdrant/bm25" },
                    using: "bm25",
                    limit: prefetchLimit,
                    filter: activeFilter,
                },
            ],
            query: { fusion: "rrf" },
            limit: opts.limit,
            with_payload: true,
            filter: activeFilter,
        });

        return results.points.map((r) => ({
            docId: String(r.id),
            score: r.score,
        }));
    }

    /** Wait for all pending async operations to complete. */
    async flush(): Promise<void> {
        await this.queue.flush();
    }

    async close(): Promise<void> {
        await this.flush();
        this.closed = true;
        this.client = null;
        this.memoryIndex.clear();
    }

    private async ensureCollection(): Promise<void> {
        const collections = await this.client!.getCollections();
        const exists = collections.collections.some((c) => c.name === this.config.collectionName);

        if (!exists) {
            await this.client!.createCollection(this.config.collectionName, {
                vectors: {
                    [this.vectorName]: {
                        size: this.config.dimensions,
                        distance: "Cosine",
                    },
                },
                sparse_vectors: {
                    bm25: {
                        modifier: "idf",
                    },
                },
                optimizers_config: {
                    default_segment_number: 2,
                },
                on_disk_payload: true,
            });
        }
    }
}
