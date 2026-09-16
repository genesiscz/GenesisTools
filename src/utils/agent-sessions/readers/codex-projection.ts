import { Database } from "bun:sqlite";
import { createHash, type Hash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { historyDatabasePath } from "../database";

export interface ProjectionFingerprintPart {
    database: number;
    count: number;
    ordinal: number;
    revision?: number;
    contentHash?: string;
}

export type CodexProjectionIndex = Map<string, ProjectionFingerprintPart[]>;

interface ProjectionCacheEntry {
    /** `${db mtime}:${db size}:${wal mtime}:${wal size}`; a SQLite write always moves one of them. */
    stamp: string;
    threads: Record<string, ProjectionFingerprintPart[]>;
}

type ProjectionCache = Record<string, ProjectionCacheEntry>;

interface SqliteColumnInfo {
    name: string;
}

interface ThreadItemsGroupRow {
    thread_id: string;
    count: number;
    ordinal: number;
    revision: number;
}

interface ThreadItemsScanRow {
    thread_id: string;
    rollout_ordinal: number;
    item_json: string;
}

export function sqliteColumns(database: Database, table: string): string[] {
    return database
        .query(`PRAGMA table_info(${table})`)
        .all()
        .filter(isSqliteColumnInfo)
        .map((column) => column.name);
}

function isSqliteColumnInfo(value: unknown): value is SqliteColumnInfo {
    return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

function isThreadItemsGroupRow(value: unknown): value is ThreadItemsGroupRow {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const row = value as Record<string, unknown>;

    return (
        typeof row.thread_id === "string" &&
        typeof row.count === "number" &&
        typeof row.ordinal === "number" &&
        typeof row.revision === "number"
    );
}

function asThreadItemsScanRow(value: unknown): ThreadItemsScanRow | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const row = value as Record<string, unknown>;

    if (
        typeof row.thread_id !== "string" ||
        typeof row.rollout_ordinal !== "number" ||
        typeof row.item_json !== "string"
    ) {
        return null;
    }

    return { thread_id: row.thread_id, rollout_ordinal: row.rollout_ordinal, item_json: row.item_json };
}

export function codexProjectionCachePath(): string {
    return join(dirname(historyDatabasePath()), "codex-projection-cache.json");
}

/** Undefined when the database cannot be stat'ed; a missing `-wal` means nothing is pending. */
function projectionStamp(path: string): string | undefined {
    try {
        const database = statSync(path);
        let wal = { mtimeMs: 0, size: 0 };

        if (existsSync(`${path}-wal`)) {
            wal = statSync(`${path}-wal`);
        }

        return `${database.mtimeMs}:${database.size}:${wal.mtimeMs}:${wal.size}`;
    } catch (error) {
        logger.debug({ error, path }, "[codex] projection database stat failed");
        return undefined;
    }
}

function readProjectionCache(): ProjectionCache {
    const path = codexProjectionCachePath();

    if (!existsSync(path)) {
        return {};
    }

    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ProjectionCache) : {};
    } catch (error) {
        logger.warn({ error, path }, "[codex] projection cache unreadable; rebuilding it");
        return {};
    }
}

function writeProjectionCache(cache: ProjectionCache): void {
    const path = codexProjectionCachePath();
    const temp = `${path}.${process.pid}.tmp`;

    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temp, SafeJSON.stringify(cache, { strict: true }));
        renameSync(temp, path);
    } catch (error) {
        logger.warn({ error, path }, "[codex] projection cache write failed; next listing recomputes it");
    }
}

/**
 * Every thread's projection parts from a home's `thread_history*.sqlite` files, one pass per
 * database. The per-source read below opened each database and scanned `thread_items` once per
 * rollout: 364 rollouts on this machine meant 364 opens and 364 table scans, 550 ms of every
 * `tools ai usage sessions`. Grouped by thread the same rows are read once, and the parts a
 * thread gets are byte-identical to the per-source ones, so no stored fingerprint changes.
 */
export function readCodexProjectionIndex(
    metadataPaths: readonly string[],
    onIssue: (path: string) => void
): CodexProjectionIndex {
    const index: CodexProjectionIndex = new Map();
    const paths = metadataPaths.filter((path) => /thread_history(?:_\d+)?\.sqlite$/.test(path));
    // Keyed by database path and stamped with the file's mtime and size (WAL included): a
    // listing while codex is idle reuses the parts and never opens the database, which was 230
    // to 300 ms per home for every `tools ai usage sessions` Genesis.app fires every 35 s.
    const cache = readProjectionCache();
    let dirty = false;
    let threads: Record<string, ProjectionFingerprintPart[]> = {};
    const push = (threadId: string, part: ProjectionFingerprintPart) => {
        const parts = threads[threadId] ?? [];
        parts.push(part);
        threads[threadId] = parts;
    };
    const merge = (databaseIndex: number) => {
        for (const [threadId, parts] of Object.entries(threads)) {
            const indexed = index.get(threadId) ?? [];

            for (const part of parts) {
                indexed.push({ ...part, database: databaseIndex });
            }

            index.set(threadId, indexed);
        }
    };

    for (const [databaseIndex, path] of paths.entries()) {
        const stamp = projectionStamp(path);
        const cached = stamp === undefined ? undefined : cache[path];

        if (cached && cached.stamp === stamp) {
            threads = cached.threads;
            merge(databaseIndex);
            continue;
        }

        threads = {};
        let database: Database | undefined;
        try {
            database = new Database(path, { readonly: true });
            const columns = sqliteColumns(database, "thread_items");
            if (
                !columns.includes("thread_id") ||
                !columns.includes("rollout_ordinal") ||
                !columns.includes("item_json")
            ) {
                continue;
            }
            if (columns.includes("updated_at_ordinal")) {
                const rows = database
                    .query(
                        "SELECT thread_id, count(*) AS count, coalesce(max(rollout_ordinal), 0) AS ordinal, coalesce(max(updated_at_ordinal), 0) AS revision FROM thread_items GROUP BY thread_id"
                    )
                    .all()
                    .filter(isThreadItemsGroupRow);
                for (const row of rows) {
                    if (row.count > 0) {
                        push(row.thread_id, {
                            database: databaseIndex,
                            count: row.count,
                            ordinal: row.ordinal,
                            revision: row.revision,
                        });
                    }
                }
            } else {
                let current: { threadId: string; hash: Hash; count: number; ordinal: number } | undefined;
                const flush = () => {
                    if (current && current.count > 0) {
                        push(current.threadId, {
                            database: databaseIndex,
                            count: current.count,
                            ordinal: current.ordinal,
                            contentHash: current.hash.digest("hex"),
                        });
                    }
                };
                for (const raw of database
                    .query(
                        "SELECT thread_id, rollout_ordinal, item_json FROM thread_items ORDER BY thread_id, rollout_ordinal"
                    )
                    .iterate()) {
                    const row = asThreadItemsScanRow(raw);
                    if (!row) {
                        continue;
                    }
                    if (!current || current.threadId !== row.thread_id) {
                        flush();
                        current = { threadId: row.thread_id, hash: createHash("sha256"), count: 0, ordinal: 0 };
                    }
                    current.count++;
                    current.ordinal = Math.max(current.ordinal, row.rollout_ordinal);
                    current.hash.update(`${row.rollout_ordinal}:${row.item_json}\n`);
                }
                flush();
            }
        } catch (error) {
            logger.warn({ error, path }, "[codex] projection database unreadable");
            onIssue(path);
            threads = {};
            continue;
        } finally {
            database?.close();
        }

        merge(databaseIndex);

        if (stamp !== undefined) {
            cache[path] = { stamp, threads };
            dirty = true;
        }
    }

    if (dirty) {
        writeProjectionCache(cache);
    }

    return index;
}
