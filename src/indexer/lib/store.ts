import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Embedder } from "@app/utils/ai/tasks/Embedder";
import { SafeJSON } from "@app/utils/json";
import { FTS5SearchEngine } from "@app/utils/search/drivers/sqlite-fts5/index";
import type { SearchOptions, SearchResult } from "@app/utils/search/types";
import { Storage } from "@app/utils/storage/storage";
import { deserializeMerkleTree, serializeMerkleTree } from "./merkle";
import type { ChunkRecord, IndexConfig, IndexMeta, IndexStats, MerkleNode } from "./types";

export interface IndexStore {
    insertChunks(chunks: ChunkRecord[], embeddings?: Map<string, Float32Array>): Promise<void>;
    removeChunks(chunkIds: string[]): Promise<void>;
    search(opts: SearchOptions): Promise<SearchResult<ChunkRecord>[]>;
    getStats(): IndexStats;
    getMeta(): IndexMeta;
    updateMeta(updates: Partial<Pick<IndexMeta, "lastSyncAt" | "stats">>): void;
    saveMerkle(tree: MerkleNode): Promise<void>;
    loadMerkle(): Promise<MerkleNode | null>;
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
            stats: {
                totalFiles: 0,
                totalChunks: 0,
                totalEmbeddings: 0,
                embeddingDimensions: 0,
                dbSizeBytes: 0,
                lastSyncDurationMs: 0,
                searchCount: 0,
                avgSearchDurationMs: 0,
            },
            lastSyncAt: null,
            createdAt,
        };
    }

    return SafeJSON.parse(row.value) as IndexMeta;
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

    db.run(`CREATE TABLE IF NOT EXISTS merkle_tree (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tree TEXT
    )`);

    const createdAt = Date.now();
    const existingMeta = db.query("SELECT value FROM index_meta WHERE key = 'meta'").get() as { value: string } | null;

    if (!existingMeta) {
        const initialMeta: IndexMeta = {
            name: config.name,
            config,
            stats: {
                totalFiles: 0,
                totalChunks: 0,
                totalEmbeddings: 0,
                embeddingDimensions: 0,
                dbSizeBytes: 0,
                lastSyncDurationMs: 0,
                searchCount: 0,
                avgSearchDurationMs: 0,
            },
            lastSyncAt: null,
            createdAt,
        };
        db.run("INSERT INTO index_meta (key, value) VALUES (?, ?)", ["meta", SafeJSON.stringify(initialMeta)]);
    }

    const fts = FTS5SearchEngine.fromDatabase<ChunkDoc>(db, {
        tableName,
        schema: {
            textFields: ["content", "name", "filePath"],
            idField: "id",
            vectorField: "content",
        },
        embedder,
    });

    const store: IndexStore = {
        async insertChunks(chunks: ChunkRecord[], embeddings?: Map<string, Float32Array>): Promise<void> {
            if (chunks.length === 0) {
                return;
            }

            const contentTable = `${tableName}_content`;

            const tx = db.transaction(() => {
                for (const chunk of chunks) {
                    db.run(`INSERT OR REPLACE INTO ${contentTable} (id, content, name, filePath) VALUES (?, ?, ?, ?)`, [
                        chunk.id,
                        chunk.content,
                        chunk.name ?? "",
                        chunk.filePath,
                    ]);
                }

                if (embeddings && embeddings.size > 0) {
                    const embTable = `${tableName}_embeddings`;

                    db.run(`CREATE TABLE IF NOT EXISTS ${embTable} (
                        doc_id TEXT PRIMARY KEY,
                        embedding BLOB NOT NULL
                    )`);

                    for (const [chunkId, vector] of embeddings) {
                        const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
                        db.run(`INSERT OR REPLACE INTO ${embTable} (doc_id, embedding) VALUES (?, ?)`, [chunkId, blob]);
                    }
                }
            });

            tx();
        },

        async removeChunks(chunkIds: string[]): Promise<void> {
            if (chunkIds.length === 0) {
                return;
            }

            for (const id of chunkIds) {
                await fts.remove(id);
            }
        },

        async search(opts: SearchOptions): Promise<SearchResult<ChunkRecord>[]> {
            const results = await fts.search(opts);
            return results.map((r) => ({
                doc: r.doc as unknown as ChunkRecord,
                score: r.score,
                method: r.method,
            }));
        },

        getStats(): IndexStats {
            const chunkCount = fts.count;

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

        getMeta(): IndexMeta {
            return readMeta(db, config, createdAt);
        },

        updateMeta(updates: Partial<Pick<IndexMeta, "lastSyncAt" | "stats">>): void {
            const current = readMeta(db, config, createdAt);

            if (updates.lastSyncAt !== undefined) {
                current.lastSyncAt = updates.lastSyncAt;
            }

            if (updates.stats) {
                current.stats = { ...current.stats, ...updates.stats };
            }

            db.run("INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)", [
                "meta",
                SafeJSON.stringify(current),
            ]);
        },

        async saveMerkle(tree: MerkleNode): Promise<void> {
            const serialized = serializeMerkleTree(tree);
            db.run("INSERT OR REPLACE INTO merkle_tree (id, tree) VALUES (1, ?)", [serialized]);
        },

        async loadMerkle(): Promise<MerkleNode | null> {
            const row = db.query("SELECT tree FROM merkle_tree WHERE id = 1").get() as { tree: string } | null;

            if (!row) {
                return null;
            }

            return deserializeMerkleTree(row.tree);
        },

        logSearch(entry: { query: string; mode: string; resultsCount: number; durationMs: number }): void {
            db.run(
                "INSERT INTO search_log (query, mode, results_count, duration_ms, searched_at) VALUES (?, ?, ?, ?, ?)",
                [entry.query, entry.mode, entry.resultsCount, entry.durationMs, new Date().toISOString()]
            );
        },

        async close(): Promise<void> {
            await fts.close();
            db.close();
        },
    };

    return store;
}
