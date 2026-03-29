import { AsyncOpQueue } from "@app/utils/async";
import { ensurePackage } from "@app/utils/packages";
import { bruteForceVectorSearch, type VectorSearchHit, type VectorStore } from "./vector-store";

interface ArrowVector {
    toArray(): Float32Array;
}

interface LanceDBRow {
    id: string;
    vector: ArrowVector;
    _distance?: number;
}

interface LanceDBTable {
    add(data: Array<{ id: string; vector: number[] }>): Promise<void>;
    delete(predicate: string): Promise<void>;
    mergeInsert(on: string): {
        whenMatchedUpdateAll(): {
            whenNotMatchedInsertAll(): {
                execute(data: Array<{ id: string; vector: number[] }>): Promise<void>;
            };
        };
    };
    search(query: number[]): {
        distanceType(type: string): {
            limit(n: number): {
                toArray(): Promise<LanceDBRow[]>;
            };
        };
    };
    query(): {
        toArray(): Promise<LanceDBRow[]>;
    };
    countRows(): Promise<number>;
}

interface LanceDBConnection {
    createTable(name: string, data: Array<{ id: string; vector: number[] }>): Promise<LanceDBTable>;
    openTable(name: string): Promise<LanceDBTable>;
    tableNames(): Promise<string[]>;
}

export interface LanceDBVectorStoreConfig {
    /** Directory path for the LanceDB database */
    dbPath: string;
    /** Table name within the LanceDB database */
    tableName: string;
    /** Vector dimensions (used for initial seed vector if table does not exist) */
    dimensions: number;
}

/**
 * VectorStore backed by LanceDB — an embedded columnar vector database
 * that supports ANN (approximate nearest neighbor) search.
 *
 * LanceDB is async-native, so this adapter buffers operations and flushes
 * them internally, keeping the VectorStore interface synchronous as required.
 */
export class LanceDBVectorStore implements VectorStore {
    private config: LanceDBVectorStoreConfig;
    private db: LanceDBConnection | null = null;
    private table: LanceDBTable | null = null;
    private initPromise: Promise<void> | null = null;
    private queue = new AsyncOpQueue("LanceDBVectorStore");
    /** In-memory mirror for synchronous search fallback while async ops are pending */
    private memoryIndex = new Map<string, Float32Array>();
    private closed = false;

    constructor(config: LanceDBVectorStoreConfig) {
        this.config = config;
        this.initPromise = this.initialize();
    }

    store(id: string, vector: Float32Array): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.set(id, new Float32Array(vector));

        this.queue.enqueue(async () => {
            await this.ensureReady();

            await this.table!.mergeInsert("id")
                .whenMatchedUpdateAll()
                .whenNotMatchedInsertAll()
                .execute([{ id, vector: Array.from(vector) }]);
        });
    }

    remove(id: string): void {
        if (this.closed) {
            return;
        }

        this.memoryIndex.delete(id);

        this.queue.enqueue(async () => {
            await this.ensureReady();

            try {
                await this.table!.delete(`id = '${id.replace(/'/g, "''")}'`);
            } catch {
                // Row may not exist — ignore
            }
        });
    }

    search(queryVector: Float32Array, limit: number): VectorSearchHit[] {
        return bruteForceVectorSearch(this.memoryIndex, queryVector, limit);
    }

    count(): number {
        return this.memoryIndex.size;
    }

    /**
     * Wait for all pending async operations to complete.
     * Call this before reading from LanceDB directly or before closing.
     */
    async flush(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
            this.initPromise = null;
        }

        await this.queue.flush();
    }

    async close(): Promise<void> {
        await this.flush();
        this.closed = true;
        this.db = null;
        this.table = null;
        this.memoryIndex.clear();
    }

    /**
     * Perform an async vector search directly against LanceDB.
     * Use this when you need ANN results (vs the synchronous brute-force fallback).
     */
    async searchAsync(queryVector: Float32Array, limit: number): Promise<VectorSearchHit[]> {
        await this.flush();

        if (!this.table) {
            return [];
        }

        const results = await this.table.search(Array.from(queryVector)).distanceType("cosine").limit(limit).toArray();

        return results.map((r) => {
            const distance = r._distance ?? 0;
            return {
                docId: r.id,
                score: 1 - distance,
            };
        });
    }

    private async initialize(): Promise<void> {
        await ensurePackage("@lancedb/lancedb", { label: "LanceDB vector store" });
        const lancedb = await import("@lancedb/lancedb");
        this.db = (await lancedb.connect(this.config.dbPath)) as unknown as LanceDBConnection;

        const tableNames = await this.db.tableNames();

        if (tableNames.includes(this.config.tableName)) {
            this.table = await this.db.openTable(this.config.tableName);

            // Load existing data into memory index via query() (returns Arrow vectors)
            const allRows = await this.table.query().toArray();

            for (const row of allRows) {
                if (row.vector) {
                    this.memoryIndex.set(row.id, new Float32Array(row.vector.toArray()));
                }
            }
        }
    }

    private async ensureReady(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
            this.initPromise = null;
        }

        if (!this.table && this.db) {
            // Create the table with a seed row, then delete it
            const seedVector = new Array(this.config.dimensions).fill(0);
            this.table = await this.db.createTable(this.config.tableName, [{ id: "__seed__", vector: seedVector }]);
            await this.table.delete("id = '__seed__'");
        }
    }
}
