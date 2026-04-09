import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import logger from "@app/logger";
import { Embedder } from "@app/utils/ai/tasks/Embedder";
import { acquireLock, type LockHandle } from "@app/utils/fs/lock";
import { SafeJSON } from "@app/utils/json";
import { SearchEngine } from "@app/utils/search/drivers/sqlite-fts5/index";
import type { QdrantVectorStore } from "@app/utils/search/stores/qdrant-vector-store";
import { ensureExtensionCapableSQLite, loadSqliteVec } from "@app/utils/search/stores/sqlite-vec-loader";
import type { VectorStore } from "@app/utils/search/stores/vector-store";
import type { SearchOptions, SearchResult } from "@app/utils/search/types";
import { deserializeMerkleTree } from "./merkle";
import { PathHashStore } from "./path-hashes";
import { getDbSizeBytes, getIndexerStorage, sanitizeName } from "./storage";
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
    /** Save a serialized code graph */
    saveCodeGraph(graphJson: string, builtAt: number): void;
    /** Load the persisted code graph, or null if not present */
    loadCodeGraph(): { graphJson: string; builtAt: number } | null;
    logSearch(entry: { query: string; mode: string; resultsCount: number; durationMs: number }): void;
    close(): Promise<void>;
}

interface ChunkDoc extends Record<string, unknown> {
    id: string;
    content: string;
    name: string;
    filePath: string;
}

/** Max bind parameters per SQL IN(...) clause */
const SQL_BATCH_SIZE = 500;

/**
 * Run a batched SQL query for large ID lists that exceed SQLite bind limits.
 * Slices `ids` into batches, builds IN(?,?,...) placeholders, calls `queryFn`.
 */
function runBatchedQuery<TResult>(opts: {
    ids: string[];
    queryFn: (placeholders: string, batch: string[]) => TResult[];
}): TResult[] {
    const { ids, queryFn } = opts;
    const results: TResult[] = [];

    for (let i = 0; i < ids.length; i += SQL_BATCH_SIZE) {
        const batch = ids.slice(i, i + SQL_BATCH_SIZE);
        const placeholders = batch.map(() => "?").join(",");
        results.push(...queryFn(placeholders, batch));
    }

    return results;
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

export type ReadonlySearchMode = "fulltext" | "hybrid" | "vector" | "auto";

export interface ReadonlySearchOptions {
    mode?: ReadonlySearchMode;
    limit?: number;
    /** When false, skip vector-store/embedder construction even if hybrid/vector requested. Default: true. */
    enableVector?: boolean;
}

async function createReadonlyEmbedder(meta: IndexMeta): Promise<Embedder | null> {
    if (!meta.indexEmbedding) {
        return null;
    }

    try {
        return await Embedder.create({
            provider: meta.indexEmbedding.provider,
            model: meta.indexEmbedding.model,
        });
    } catch (err) {
        logger.debug(
            `[searchIndexReadonly] failed to construct embedder (${meta.indexEmbedding.provider}/${meta.indexEmbedding.model}): ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
    }
}

/**
 * Search an index in read-only mode — no lock, safe for concurrent access.
 * Uses SQLite WAL mode's natural concurrent-read support.
 *
 * Supports fulltext, hybrid, vector, and "auto" (picks hybrid when the index
 * has stored embeddings and an embedder can be constructed, else fulltext).
 * Always falls back to fulltext on embedder/extension failure — never throws.
 */
export async function searchIndexReadonly(
    indexName: string,
    query: string,
    opts?: ReadonlySearchOptions
): Promise<SearchResult<ChunkRecord>[]> {
    const indexDir = getIndexerStorage().getIndexDir(indexName);
    const dbPath = join(indexDir, "index.db");

    if (!existsSync(dbPath)) {
        throw new Error(`Index "${indexName}" database not found at ${dbPath}`);
    }

    // sqlite-vec needs extension-capable SQLite loaded BEFORE any Database() in this process.
    ensureExtensionCapableSQLite();

    const db = new Database(dbPath, { readonly: true });
    const tableName = sanitizeName(indexName);

    try {
        const meta = readMeta(db, { name: indexName } as IndexConfig, Date.now());
        const hasEmbeddings = (meta.stats?.totalEmbeddings ?? 0) > 0 && !!meta.indexEmbedding;

        const requestedMode = opts?.mode ?? "auto";
        let resolvedMode: "fulltext" | "hybrid" | "vector";

        if (requestedMode === "auto") {
            resolvedMode = hasEmbeddings ? "hybrid" : "fulltext";
        } else {
            resolvedMode = requestedMode;
        }

        // Construct embedder only when we actually need vectors at query time.
        let embedder: Embedder | undefined;
        // Choose vector driver based on which table the index actually uses.
        let vectorDriver: "sqlite-vec" | "sqlite-brute" | undefined;

        if (resolvedMode !== "fulltext" && opts?.enableVector !== false) {
            const vecTableExists = !!db
                .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                .get(`${tableName}_vec`);
            const embTableExists = !!db
                .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
                .get(`${tableName}_embeddings`);

            if (!vecTableExists && !embTableExists) {
                logger.warn(
                    `[searchIndexReadonly] index "${indexName}" has no vector tables — falling back to fulltext`
                );
                resolvedMode = "fulltext";
            } else {
                if (vecTableExists) {
                    loadSqliteVec(db);
                    vectorDriver = "sqlite-vec";
                } else {
                    vectorDriver = "sqlite-brute";
                }

                const e = await createReadonlyEmbedder(meta);

                if (!e) {
                    logger.warn(
                        `[searchIndexReadonly] index "${indexName}" requested ${resolvedMode} but no embedder available — falling back to fulltext`
                    );
                    resolvedMode = "fulltext";
                    vectorDriver = undefined;
                } else if (meta.indexEmbedding && e.dimensions !== meta.indexEmbedding.dimensions) {
                    logger.warn(
                        `[searchIndexReadonly] embedder dimensions ${e.dimensions} ≠ stored ${meta.indexEmbedding.dimensions} — falling back to fulltext`
                    );
                    resolvedMode = "fulltext";
                    vectorDriver = undefined;
                } else {
                    embedder = e;
                }
            }
        }

        const fts = SearchEngine.fromDatabase<ChunkDoc>(db, {
            tableName,
            schema: {
                textFields: ["content", "name", "filePath"],
                idField: "id",
                vectorField: "content",
            },
            embedder,
            vectorDriver,
            skipSchemaInit: true,
        });

        const results = await fts.search({
            query,
            mode: resolvedMode,
            limit: opts?.limit ?? 100,
        });

        return results.map((r: SearchResult<ChunkDoc>) => ({
            doc: r.doc as unknown as ChunkRecord,
            score: r.score,
            method: r.method,
        }));
    } finally {
        db.close();
    }
}

export async function createIndexStore(config: IndexConfig, embedder?: Embedder): Promise<IndexStore> {
    const indexDir = getIndexerStorage().getIndexDir(config.name);

    if (!existsSync(indexDir)) {
        mkdirSync(indexDir, { recursive: true });
    }

    // Cross-process lock via proper-lockfile — acquire BEFORE opening DB
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

    // Ensure extension-capable SQLite is loaded BEFORE creating Database instances.
    // Must happen before the first new Database() call in this process.
    if (config.storage?.vectorDriver !== "sqlite-brute" && config.storage?.vectorDriver !== "qdrant") {
        ensureExtensionCapableSQLite();
    }

    const dbPath = join(indexDir, "index.db");
    let db: InstanceType<typeof Database>;

    try {
        db = new Database(dbPath);
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

        db.run(`CREATE TABLE IF NOT EXISTS code_graph (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        graph_json TEXT NOT NULL,
        built_at INTEGER NOT NULL
    )`);

        // PathHashStore creates its own table
        const pathHashStore = new PathHashStore(db);

        // Migrate old merkle_tree blob to path_hashes if needed
        migrateFromMerkleBlob(db, pathHashStore);

        const createdAt = Date.now();
        const existingMeta = db.query("SELECT value FROM index_meta WHERE key = 'meta'").get() as {
            value: string;
        } | null;

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

        // Cached parsed meta — avoids repeated SELECT + JSON.parse
        let cachedMeta: IndexMeta | null = null;

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

                cachedMeta = null;

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
                            const chunkMap = new Map(chunks.map((c) => [c.id, c]));

                            for (const [chunkId, vector] of embeddings) {
                                const chunk = chunkMap.get(chunkId);
                                const text = chunk?.content ?? "";
                                qdrantStore.storeWithText(chunkId, vector, text);
                            }

                            // Record in local embeddings table so getUnembeddedChunkIds() stays correct.
                            // Uses zero-length blob since the actual vectors live in Qdrant.
                            if (!embTableExists) {
                                db.run(`CREATE TABLE IF NOT EXISTS ${embTable} (
                                doc_id TEXT PRIMARY KEY,
                                embedding BLOB NOT NULL
                            )`);
                                embTableExists = true;
                            }

                            const marker = Buffer.alloc(0);

                            for (const chunkId of embeddings.keys()) {
                                db.run(`INSERT OR REPLACE INTO ${embTable} (doc_id, embedding) VALUES (?, ?)`, [
                                    chunkId,
                                    marker,
                                ]);
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

                cachedMeta = null;

                const tx = db.transaction(() => {
                    runBatchedQuery({
                        ids: chunkIds,
                        queryFn: (placeholders, batch) => {
                            db.run(`DELETE FROM ${contentTable} WHERE id IN (${placeholders})`, batch);

                            if (embTableExists) {
                                db.run(`DELETE FROM ${activeEmbTable} WHERE doc_id IN (${placeholders})`, batch);
                            }

                            return [];
                        },
                    });
                });
                tx();

                const vectorStoreForRemoval = fts.getVectorStore();

                if (vectorStoreForRemoval) {
                    if (vectorStoreForRemoval.removeMany) {
                        vectorStoreForRemoval.removeMany(chunkIds);
                    } else {
                        for (const id of chunkIds) {
                            vectorStoreForRemoval.remove(id);
                        }
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

                return runBatchedQuery({
                    ids,
                    queryFn: (placeholders, batch) =>
                        db
                            .query(`SELECT id, content FROM ${contentTable} WHERE id IN (${placeholders})`)
                            .all(...batch) as Array<{ id: string; content: string }>,
                });
            },

            getChunkIdsBySourcePaths(paths: string[]): string[] {
                if (paths.length === 0) {
                    return [];
                }

                return runBatchedQuery({
                    ids: paths,
                    queryFn: (placeholders, batch) => {
                        const rows = db
                            .query(`SELECT id FROM ${contentTable} WHERE filePath IN (${placeholders})`)
                            .all(...batch) as Array<{ id: string }>;
                        return rows.map((r) => r.id);
                    },
                });
            },

            getChunkIdsBySourceIds(ids: string[]): string[] {
                if (ids.length === 0) {
                    return [];
                }

                return runBatchedQuery({
                    ids,
                    queryFn: (placeholders, batch) => {
                        const rows = db
                            .query(`SELECT id FROM ${contentTable} WHERE source_id IN (${placeholders})`)
                            .all(...batch) as Array<{ id: string }>;
                        return rows.map((r) => r.id);
                    },
                });
            },

            clearEmbeddings(): void {
                cachedMeta = null;

                if (embTableExists) {
                    db.run(`DELETE FROM ${activeEmbTable}`);
                }
            },

            clearEmbeddingsBySourceIds(sourceIds: string[]): void {
                if (sourceIds.length === 0 || !embTableExists) {
                    return;
                }

                cachedMeta = null;

                const tx = db.transaction(() => {
                    runBatchedQuery({
                        ids: sourceIds,
                        queryFn: (placeholders, batch) => {
                            db.run(
                                `DELETE FROM ${activeEmbTable} WHERE doc_id IN (SELECT id FROM ${contentTable} WHERE source_id IN (${placeholders}))`,
                                batch
                            );
                            return [];
                        },
                    });
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

                // Live embedding count from actual table
                let embeddingCount = 0;

                if (embTableExists) {
                    const embRow = db.query(`SELECT COUNT(*) AS cnt FROM ${activeEmbTable}`).get() as {
                        cnt: number;
                    };
                    embeddingCount = embRow.cnt;
                }

                const dbSizeBytes = getDbSizeBytes(dbPath);

                const logStats = db
                    .query("SELECT COUNT(*) AS cnt, AVG(duration_ms) AS avg_ms FROM search_log")
                    .get() as {
                    cnt: number;
                    avg_ms: number | null;
                };

                const meta = cachedMeta ?? readMeta(db, config, createdAt);

                return {
                    totalFiles: meta.stats.totalFiles,
                    totalChunks: chunkCount,
                    totalEmbeddings: embeddingCount,
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
                if (cachedMeta) {
                    return cachedMeta;
                }

                cachedMeta = readMeta(db, config, createdAt);
                return cachedMeta;
            },

            updateMeta(
                updates: Partial<
                    Pick<IndexMeta, "lastSyncAt" | "stats" | "indexEmbedding" | "searchEmbedding" | "indexingStatus">
                >
            ): void {
                const current = cachedMeta ?? readMeta(db, config, createdAt);

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

                cachedMeta = current;
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

            saveCodeGraph(graphJson: string, builtAt: number): void {
                db.run("INSERT OR REPLACE INTO code_graph (id, graph_json, built_at) VALUES (1, ?, ?)", [
                    graphJson,
                    builtAt,
                ]);
            },

            loadCodeGraph(): { graphJson: string; builtAt: number } | null {
                const row = db.query("SELECT graph_json, built_at FROM code_graph WHERE id = 1").get() as {
                    graph_json: string;
                    built_at: number;
                } | null;

                if (!row) {
                    return null;
                }

                return { graphJson: row.graph_json, builtAt: row.built_at };
            },

            logSearch(entry: { query: string; mode: string; resultsCount: number; durationMs: number }): void {
                db.run(
                    "INSERT INTO search_log (query, mode, results_count, duration_ms, searched_at) VALUES (?, ?, ?, ?, ?)",
                    [entry.query, entry.mode, entry.resultsCount, entry.durationMs, new Date().toISOString()]
                );
            },

            async close(): Promise<void> {
                try {
                    if (qdrantStore) {
                        await qdrantStore.flush();
                        await qdrantStore.close();
                    }

                    await fts.close();
                    db.close();
                } finally {
                    await lockHandle.release();
                }
            },
        };

        return store;
    } catch (err) {
        // Release the lock if initialization fails — otherwise it stays held until stale
        await lockHandle.release();
        throw err;
    }
}
