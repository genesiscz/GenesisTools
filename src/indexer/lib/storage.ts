import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "@app/utils/storage/storage";

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
