import type { Database } from "bun:sqlite";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage";
import type { IndexStats } from "./types";

const TOOL_NAME = "indexer";

/** Sanitize an index name for use as a SQLite table name prefix. */
export function sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Get the total DB size including WAL file. Returns 0 if the file doesn't exist. */
export function getDbSizeBytes(dbPath: string): number {
    try {
        let size = Bun.file(dbPath).size;
        const walSize = Bun.file(`${dbPath}-wal`).size;

        if (walSize > 0) {
            size += walSize;
        }

        return size;
    } catch {
        return 0;
    }
}

/**
 * Read live chunk/embedding counts + DB size from an open (readonly) database.
 * Used by listIndexes() to show accurate stats without acquiring the index lock.
 */
export function readLiveStats(db: Database, indexName: string, dbPath: string): Partial<IndexStats> {
    const tableName = sanitizeName(indexName);
    const contentTable = `${tableName}_content`;
    const embTable = `${tableName}_embeddings`;

    const result: Partial<IndexStats> = {};

    try {
        const row = db.query(`SELECT COUNT(*) AS cnt FROM ${contentTable}`).get() as { cnt: number } | null;

        if (row) {
            result.totalChunks = row.cnt;
        }
    } catch {
        // expected — table created lazily during first sync
    }

    try {
        const row = db.query(`SELECT COUNT(*) AS cnt FROM ${embTable}`).get() as { cnt: number } | null;

        if (row) {
            result.totalEmbeddings = row.cnt;
        }
    } catch {
        // expected — table created lazily during first sync
    }

    result.dbSizeBytes = getDbSizeBytes(dbPath);
    return result;
}

/**
 * Indexer-specific storage wrapper.
 * Single source of truth for `new Storage("indexer")` — all indexer code
 * should use this instead of constructing Storage directly.
 */
export class IndexerStorage extends Storage {
    constructor() {
        super(TOOL_NAME);
    }

    /** Get the directory for a specific index (e.g. ~/.genesis-tools/indexer/<name>/) */
    getIndexDir(name: string): string {
        return join(this.getBaseDir(), name);
    }

    /** Get the DB path for a specific index */
    getIndexDbPath(name: string): string {
        return join(this.getIndexDir(name), "index.db");
    }

    /** Get the benchmarks directory */
    getBenchmarkDir(): string {
        return join(this.getBaseDir(), "benchmarks");
    }

    /**
     * Remove stale index directories matching a prefix.
     * Used by tests and benchmarks to clean up after crashed runs.
     */
    cleanStaleDirs(prefix: string): number {
        let cleaned = 0;

        try {
            for (const entry of readdirSync(this.getBaseDir())) {
                if (entry.startsWith(prefix)) {
                    rmSync(join(this.getBaseDir(), entry), { recursive: true, force: true });
                    cleaned++;
                }
            }
        } catch {
            // best-effort — base dir may not exist
        }

        return cleaned;
    }
}

/** Shared singleton — avoids repeated construction */
let _instance: IndexerStorage | null = null;

export function getIndexerStorage(): IndexerStorage {
    if (!_instance) {
        _instance = new IndexerStorage();
    }

    return _instance;
}
