import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import { acquireLock, type LockHandle } from "@app/utils/fs/lock";
import { SafeJSON } from "@app/utils/json";
import { SearchEngine } from "@app/utils/search/drivers/sqlite-fts5/index";
import type { QdrantVectorStore } from "@app/utils/search/stores/qdrant-vector-store";
import type { VectorStore } from "@app/utils/search/stores/vector-store";
import type { SearchOptions, SearchResult } from "@app/utils/search/types";
import { Storage } from "@app/utils/storage/storage";
import { deserializeMerkleTree } from "./merkle";
import { PathHashStore } from "./path-hashes";
import {
    type ChunkRecord,
    emptyStats,
    type IndexConfig,
    type IndexMeta,
    type IndexStats,
    type MerkleNode,
} from "./types";

export interface IndexStore {
    insertChunks(chunks: ChunkRecord[], embeddings?: Map<string, Float32Array>): Promise<void>;
    removeChunks(chunkIds: string[]): Promise<void>;
    /** Get chunk IDs that exist in content table but have no embedding */
    getUnembeddedChunkIds(): string[];
    /** Count chunks that have no embedding (without loading IDs into memory) */
    getUnembeddedCount(): number;
    /** Get a page of unembedded chunks (id + content) for streaming embedding */
    getUnembeddedChunksPage(limit: number): Array<{ id: string; content: string }>;
    /** Get chunk content by IDs (for re-embedding) */
    getChunkContents(ids: string[]): Array<{ id: string; content: string }>;
    /** Get chunk IDs that belong to the given source file paths */
    getChunkIdsBySourcePaths(paths: string[]): string[];
    /** Get chunk IDs by source entry ID (stored in source_id column) */
    getChunkIdsBySourceIds(ids: string[]): string[];
    /** Drop all embeddings so they get re-generated on next sync */
    clearEmbeddings(): void;
    /** Drop embeddings for chunks that belong to the given source IDs */
    clearEmbeddingsBySourceIds(sourceIds: string[]): void;
    search(opts: SearchOptions): Promise<SearchResult<ChunkRecord>[]>;
    getStats(): IndexStats;
    getContentCount(): number;
    getEmbeddingCount(): number;
    getMeta(): IndexMeta;
    updateMeta(
        updates: Partial<
            Pick<IndexMeta, "lastSyncAt" | "stats" | "indexEmbedding" | "searchEmbedding" | "indexingStatus">
        >
    ): void;
    getPathHashStore(): PathHashStore;
    /** Run PRAGMA integrity_check on the underlying SQLite database */
    checkIntegrity(): string;
    /** Get all file contents from the content table (for graph building) */
    getAllFileContents(): Map<string, string>;
    logSearch(entry: { query: string; mode: string; resultsCount: number; durationMs: number }): void;
    close(): Promise<void>;
}

interface ChunkDoc extends Record<string, unknown> {
    id: string;
    content: string;
    name: string;
    filePath: string;
}

function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function readMeta(db: Database, config: IndexConfig, createdAt: number): IndexMeta {
    const row = db.query("SELECT value FROM index_meta WHERE key = 'meta'").get() as { value: string } | null;

    if (!row) {
        return {
            name: config.name,
            config,
            stats: emptyStats(),
            lastSyncAt: null,
            createdAt,
        };
    }

    return SafeJSON.parse(row.value) as IndexMeta;
}

/**
 * Migrate from old merkle_tree JSON blob to path_hashes table.
 * Extracts file leaf nodes from the serialized tree and populates path_hashes.
 */
function migrateFromMerkleBlob(db: Database, pathHashStore: PathHashStore): void {
    const tableExists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='merkle_tree'").get() as {
        name: string;
    } | null;

    if (!tableExists) {
        return;
    }

    const row = db.query("SELECT tree FROM merkle_tree WHERE id = 1").get() as { tree: string } | null;

    if (!row) {
        return;
    }

    // Check if path_hashes already has data (already migrated)
    const existing = db.query("SELECT COUNT(*) AS cnt FROM path_hashes").get() as { cnt: number };

    if (existing.cnt > 0) {
        return;
    }

    const tree = deserializeMerkleTree(row.tree);
    const entries: Array<{ path: string; hash: string; isFile: boolean }> = [];

    function collectLeaves(node: MerkleNode): void {
        if (node.isFile) {
            entries.push({ path: node.path, hash: node.hash, isFile: true });
            return;
        }

        if (node.children) {
            for (const child of node.children) {
                collectLeaves(child);
            }
        }
    }

    collectLeaves(tree);

    if (entries.length > 0) {
        pathHashStore.bulkSync(entries);
    }

    // Drop the old table after successful migration
    db.run("DROP TABLE merkle_tree");
}

export async function createIndexStore(config: IndexConfig, embedder?: Embedder): Promise<IndexStore> {
    const storage = new Storage("indexer");
    const indexDir = join(storage.getBaseDir(), config.name);

    if (!existsSync(indexDir)) {
        mkdirSync(indexDir, { recursive: true });
    }

    const dbPath = join(indexDir, "index.db");
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");

    const tableName = sanitizeName(config.name);

    db.run(`CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS search_log (
        id INTEGER PRIMARY KEY,
        query TEXT,
        mode TEXT,
        results_count INTEGER,
        duration_ms REAL,
        searched_at TEXT
    )`);

    // PathHashStore creates its own table
    const pathHashStore = new PathHashStore(db);

    // Migrate old merkle_tree blob to path_hashes if needed
    migrateFromMerkleBlob(db, pathHashStore);

    const createdAt = Date.now();
    const existingMeta = db.query("SELECT value FROM index_meta WHERE key = 'meta'").get() as { value: string } | null;

    if (!existingMeta) {
        const initialMeta: IndexMeta = {
            name: config.name,
            config,
            stats: emptyStats(),
            lastSyncAt: null,
            createdAt,
        };
        db.run("INSERT INTO index_meta (key, value) VALUES (?, ?)", ["meta", SafeJSON.stringify(initialMeta)]);
    }

    // Cross-process lock via proper-lockfile (stale detection + auto-refresh)
    const lockPath = join(indexDir, "index.lock");
    let lockHandle: LockHandle;

    try {
        lockHandle = await acquireLock(lockPath, {
            staleMs: 120_000,
            updateMs: 30_000,
            retries: 0,
        });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ELOCKED") {
            throw new Error(
                `Index "${config.name}" is locked by another process. ` +
                    `If this is stale, it will auto-expire in 2 minutes.`
            );
        }

        throw err;
    }

    // Optional Qdrant vector backend
    let externalVectorStore: VectorStore | undefined;
    let qdrantStore: QdrantVectorStore | undefined;

    if (config.storage?.vectorDriver === "qdrant") {
        const qdrantConfig = config.storage.qdrant;

        if (!qdrantConfig?.url) {
            throw new Error("Qdrant vectorDriver requires storage.qdrant.url to be set");
        }

        const { QdrantVectorStore: QVS } = await import("@app/utils/search/stores/qdrant-vector-store");
        qdrantStore = new QVS({
            collectionName: qdrantConfig.collectionName ?? sanitizeName(config.name),
            dimensions: embedder?.dimensions ?? 768,
            url: qdrantConfig.url,
            apiKey: qdrantConfig.apiKey,
        });

        await qdrantStore.init();
        externalVectorStore = qdrantStore;
    }

    const fts = SearchEngine.fromDatabase<ChunkDoc>(db, {
        tableName,
        schema: {
            textFields: ["content", "name", "filePath"],
            idField: "id",
            vectorField: "content",
        },
        embedder,
        vectorStore: externalVectorStore,
        vectorDriver: externalVectorStore ? undefined : config.storage?.vectorDriver,
    });

    // ── Cached state ────────────────────────────────────────────────
    const contentTable = `${tableName}_content`;
    const embTable = `${tableName}_embeddings`;
    const vecTable = `${tableName}_vec`;

    // Determine which embedding table to check for unembedded queries.
    // When sqlite-vec is active, embeddings are in the _vec table.
    const vecTableExists = !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(vecTable);
    const activeEmbTable = vecTableExists ? vecTable : embTable;

    // Cache embeddings table existence (B11)
    let embTableExists =
        vecTableExists || !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(embTable);

    // Run source_id column migration once at store creation (B3)
    const contentTableExists = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(contentTable) as { name: string } | null;

    if (contentTableExists) {
        const hasSourceId = (db.query(`PRAGMA table_info(${contentTable})`).all() as Array<{ name: string }>).some(
            (col) => col.name === "source_id"
        );

        if (!hasSourceId) {
            db.run(`ALTER TABLE ${contentTable} ADD COLUMN source_id TEXT DEFAULT ''`);
        }
    }

    const store: IndexStore = {
        async insertChunks(chunks: ChunkRecord[], embeddings?: Map<string, Float32Array>): Promise<void> {
            if (chunks.length === 0 && (!embeddings || embeddings.size === 0)) {
                return;
            }

            const tx = db.transaction(() => {
                for (const chunk of chunks) {
                    db.run(
                        `INSERT OR REPLACE INTO ${contentTable} (id, content, name, filePath, source_id) VALUES (?, ?, ?, ?, ?)`,
                        [chunk.id, chunk.content, chunk.name ?? "", chunk.filePath, chunk.sourceId ?? ""]
                    );
                }

                if (embeddings && embeddings.size > 0) {
                    const vectorStore = fts.getVectorStore();

                    if (qdrantStore) {
                        // Qdrant: store with text for hybrid search
                        for (const [chunkId, vector] of embeddings) {
                            const chunk = chunks.find((c) => c.id === chunkId);
                            const text = chunk?.content ?? "";
                            qdrantStore.storeWithText(chunkId, vector, text);
                        }
                    } else if (vectorStore) {
                        // Route through the SearchEngine's vector store (sqlite-vec or brute-force)
                        for (const [chunkId, vector] of embeddings) {
                            vectorStore.store(chunkId, vector);
                        }
                    } else {
                        // Fallback: write directly to the embeddings table
                        if (!embTableExists) {
                            db.run(`CREATE TABLE IF NOT EXISTS ${embTable} (
                                doc_id TEXT PRIMARY KEY,
                                embedding BLOB NOT NULL
                            )`);
                            embTableExists = true;
                        }

                        for (const [chunkId, vector] of embeddings) {
                            const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
                            db.run(`INSERT OR REPLACE INTO ${embTable} (doc_id, embedding) VALUES (?, ?)`, [
                                chunkId,
                                blob,
                            ]);
                        }
                    }
                }
            });

            tx();
        },

        async removeChunks(chunkIds: string[]): Promise<void> {
            if (chunkIds.length === 0) {
                return;
            }

            const batchSize = 500;
            const tx = db.transaction(() => {
                for (let i = 0; i < chunkIds.length; i += batchSize) {
                    const batch = chunkIds.slice(i, i + batchSize);
                    const placeholders = batch.map(() => "?").join(",");
                    db.run(`DELETE FROM ${contentTable} WHERE id IN (${placeholders})`, batch);
                }
            });
            tx();

            const vectorStoreForRemoval = fts.getVectorStore();

            if (vectorStoreForRemoval) {
                for (const id of chunkIds) {
                    vectorStoreForRemoval.remove(id);
                }
            }
        },

        getUnembeddedChunkIds(): string[] {
            if (!embTableExists) {
                const rows = db.query(`SELECT id FROM ${contentTable}`).all() as Array<{ id: string }>;
                return rows.map((r) => r.id);
            }

            const rows = db
                .query(
                    `SELECT c.id FROM ${contentTable} c LEFT JOIN ${activeEmbTable} e ON c.id = e.doc_id WHERE e.doc_id IS NULL`
                )
                .all() as Array<{ id: string }>;
            return rows.map((r) => r.id);
        },

        getUnembeddedCount(): number {
            if (!embTableExists) {
                const row = db.query(`SELECT COUNT(*) AS cnt FROM ${contentTable}`).get() as { cnt: number };
                return row.cnt;
            }

            const row = db
                .query(
                    `SELECT COUNT(*) AS cnt FROM ${contentTable} c WHERE NOT EXISTS (SELECT 1 FROM ${activeEmbTable} e WHERE e.doc_id = c.id)`
                )
                .get() as { cnt: number };
            return row.cnt;
        },

        getUnembeddedChunksPage(limit: number): Array<{ id: string; content: string }> {
            if (!embTableExists) {
                return db.query(`SELECT id, content FROM ${contentTable} LIMIT ?`).all(limit) as Array<{
                    id: string;
                    content: string;
                }>;
            }

            return db
                .query(
                    `SELECT c.id, c.content FROM ${contentTable} c WHERE NOT EXISTS (SELECT 1 FROM ${activeEmbTable} e WHERE e.doc_id = c.id) LIMIT ?`
                )
                .all(limit) as Array<{ id: string; content: string }>;
        },

        getChunkContents(ids: string[]): Array<{ id: string; content: string }> {
            if (ids.length === 0) {
                return [];
            }

            const results: Array<{ id: string; content: string }> = [];
            const batchSize = 500;

            for (let i = 0; i < ids.length; i += batchSize) {
                const batch = ids.slice(i, i + batchSize);
                const placeholders = batch.map(() => "?").join(",");
                const rows = db
                    .query(`SELECT id, content FROM ${contentTable} WHERE id IN (${placeholders})`)
                    .all(...batch) as Array<{ id: string; content: string }>;
                results.push(...rows);
            }

            return results;
        },

        getChunkIdsBySourcePaths(paths: string[]): string[] {
            if (paths.length === 0) {
                return [];
            }

            const results: string[] = [];
            const batchSize = 500;

            for (let i = 0; i < paths.length; i += batchSize) {
                const batch = paths.slice(i, i + batchSize);
                const placeholders = batch.map(() => "?").join(",");
                const rows = db
                    .query(`SELECT id FROM ${contentTable} WHERE filePath IN (${placeholders})`)
                    .all(...batch) as Array<{ id: string }>;
                results.push(...rows.map((r) => r.id));
            }

            return results;
        },

        getChunkIdsBySourceIds(ids: string[]): string[] {
            if (ids.length === 0) {
                return [];
            }

            const results: string[] = [];
            const batchSize = 500;

            for (let i = 0; i < ids.length; i += batchSize) {
                const batch = ids.slice(i, i + batchSize);
                const placeholders = batch.map(() => "?").join(",");
                const rows = db
                    .query(`SELECT id FROM ${contentTable} WHERE source_id IN (${placeholders})`)
                    .all(...batch) as Array<{ id: string }>;
                results.push(...rows.map((r) => r.id));
            }

            return results;
        },

        clearEmbeddings(): void {
            if (embTableExists) {
                db.run(`DELETE FROM ${activeEmbTable}`);
            }
        },

        clearEmbeddingsBySourceIds(sourceIds: string[]): void {
            if (sourceIds.length === 0 || !embTableExists) {
                return;
            }

            const batchSize = 500;
            const tx = db.transaction(() => {
                for (let i = 0; i < sourceIds.length; i += batchSize) {
                    const batch = sourceIds.slice(i, i + batchSize);
                    const placeholders = batch.map(() => "?").join(",");
                    db.run(
                        `DELETE FROM ${activeEmbTable} WHERE doc_id IN (SELECT id FROM ${contentTable} WHERE source_id IN (${placeholders}))`,
                        batch
                    );
                }
            });
            tx();
        },

        async search(opts: SearchOptions): Promise<SearchResult<ChunkRecord>[]> {
            const minScore = opts.minScore ?? config.search?.minScore;
            const results = await fts.search({ ...opts, minScore });
            return results.map((r) => ({
                doc: r.doc as unknown as ChunkRecord,
                score: r.score,
                method: r.method,
            }));
        },

        getStats(): IndexStats {
            const countRow = db.query(`SELECT COUNT(*) AS cnt FROM ${contentTable}`).get() as { cnt: number };
            const chunkCount = countRow.cnt;

            let dbSizeBytes = 0;

            try {
                dbSizeBytes = Bun.file(dbPath).size;
            } catch {
                // File may not exist yet
            }

            const logStats = db.query("SELECT COUNT(*) AS cnt, AVG(duration_ms) AS avg_ms FROM search_log").get() as {
                cnt: number;
                avg_ms: number | null;
            };

            const meta = readMeta(db, config, createdAt);

            return {
                totalFiles: meta.stats.totalFiles,
                totalChunks: chunkCount,
                totalEmbeddings: meta.stats.totalEmbeddings,
                embeddingDimensions: meta.stats.embeddingDimensions,
                dbSizeBytes,
                lastSyncDurationMs: meta.stats.lastSyncDurationMs,
                searchCount: logStats.cnt,
                avgSearchDurationMs: logStats.avg_ms ?? 0,
            };
        },

        getContentCount(): number {
            const row = db.query(`SELECT COUNT(*) AS cnt FROM ${contentTable}`).get() as { cnt: number };
            return row.cnt;
        },

        getEmbeddingCount(): number {
            if (!embTableExists) {
                return 0;
            }

            const row = db.query(`SELECT COUNT(*) AS cnt FROM ${activeEmbTable}`).get() as { cnt: number };
            return row.cnt;
        },

        getMeta(): IndexMeta {
            return readMeta(db, config, createdAt);
        },

        updateMeta(
            updates: Partial<
                Pick<IndexMeta, "lastSyncAt" | "stats" | "indexEmbedding" | "searchEmbedding" | "indexingStatus">
            >
        ): void {
            const current = readMeta(db, config, createdAt);

            if (updates.lastSyncAt !== undefined) {
                current.lastSyncAt = updates.lastSyncAt;
            }

            if (updates.stats) {
                current.stats = { ...current.stats, ...updates.stats };
            }

            if (updates.indexEmbedding) {
                current.indexEmbedding = updates.indexEmbedding;
            }

            if (updates.searchEmbedding) {
                current.searchEmbedding = updates.searchEmbedding;
            }

            if (updates.indexingStatus !== undefined) {
                current.indexingStatus = updates.indexingStatus;
            }

            db.run("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)", [
                "meta",
                SafeJSON.stringify(current),
            ]);
        },

        getPathHashStore(): PathHashStore {
            return pathHashStore;
        },

        checkIntegrity(): string {
            const result = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
            return result.integrity_check;
        },

        getAllFileContents(): Map<string, string> {
            // Get distinct file paths from the content table
            const rows = db.query(`SELECT DISTINCT filePath FROM ${contentTable}`).all() as Array<{
                filePath: string;
            }>;
            const result = new Map<string, string>();
            const baseDir = config.baseDir;

            for (const row of rows) {
                if (result.has(row.filePath)) {
                    continue;
                }

                const absPath = isAbsolute(row.filePath) ? row.filePath : resolve(baseDir, row.filePath);

                try {
                    const content = readFileSync(absPath, "utf-8");
                    result.set(row.filePath, content);
                } catch {
                    // File may have been deleted since indexing — skip
                }
            }

            return result;
        },

        logSearch(entry: { query: string; mode: string; resultsCount: number; durationMs: number }): void {
            db.run(
                "INSERT INTO search_log (query, mode, results_count, duration_ms, searched_at) VALUES (?, ?, ?, ?, ?)",
                [entry.query, entry.mode, entry.resultsCount, entry.durationMs, new Date().toISOString()]
            );
        },

        async close(): Promise<void> {
            if (qdrantStore) {
                await qdrantStore.flush();
                await qdrantStore.close();
            }

            await fts.close();
            db.close();
            await lockHandle.release();
        },
    };

    return store;
}
