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

export interface SearchStatsByMode {
    mode: string;
    count: number;
    avgDurationMs: number;
}

/**
 * Read per-mode search stats from the search_log table.
 * Returns an empty array if the table doesn't exist yet.
 */
export function readSearchStatsByMode(db: Database): SearchStatsByMode[] {
    try {
        return db
            .query(
                `SELECT mode, COUNT(*) AS count, AVG(duration_ms) AS avgDurationMs
                 FROM search_log
                 GROUP BY mode
                 ORDER BY count DESC`
            )
            .all() as SearchStatsByMode[];
    } catch {
        // search_log table may not exist yet
        return [];
    }
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

/**
 * Test-only: drop the cached singleton so the next `getIndexerStorage()` call
 * re-reads the env (e.g. picks up a redirected `process.env.HOME`).
 * Without this, tests that set `HOME = tmpDir` in `beforeAll` leak indexes to
 * the real homedir if any earlier test in the run already constructed the
 * singleton.
 */
export function _resetIndexerStorageForTesting(): void {
    _instance = null;
}

/**
 * Every prefix or fixed name produced by a test or benchmark. Single source
 * of truth: tests register here and the run wipes any matching dirs from the
 * real homedir at startup AND afterAll, so a crashed run can never accumulate.
 *
 * Destructive: keep these prefixes narrow and collision-resistant. Do not add
 * generic names such as "test_" because users may have real indexes with those
 * names under ~/.genesis-tools/indexer.
 */
const TEST_INDEX_PREFIXES = [
    "gt_bench_",
    "gt_e2e_test_",
    "gt_indexer_test_",
    "gt_integration_test_",
    "store_emb_test_",
    "phase2-bf-",
    "dbg-phase2-",
] as const;

const TEST_INDEX_FIXED_NAMES = ["attach-test", "filters-test", "phase2-merge", "phase2-filter", "phase2-bare"] as const;

/**
 * Wipe every leftover test/bench index from the real homedir. Safe to call
 * unconditionally — only matches names tests own.
 */
export function wipeAllTestIndexes(): number {
    const storage = new IndexerStorage();
    let removed = 0;

    for (const prefix of TEST_INDEX_PREFIXES) {
        removed += storage.cleanStaleDirs(prefix);
    }

    for (const name of TEST_INDEX_FIXED_NAMES) {
        try {
            rmSync(storage.getIndexDir(name), { recursive: true, force: true });
            removed++;
        } catch {
            // not present
        }
    }

    return removed;
}
