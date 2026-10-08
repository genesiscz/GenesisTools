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

/** How the reader opens a projection database; tests pass one that fails. */
export type ProjectionOpener = (path: string) => Database;

export interface ReadCodexProjectionOptions {
    open?: ProjectionOpener;
    /** The pause before the one retry of a database codex is rewriting. */
    retryDelayMs?: number;
}

const RETRYABLE_CODES = new Set(["SQLITE_CANTOPEN", "SQLITE_BUSY"]);

/**
 * `SQLITE_CANTOPEN` and `SQLITE_BUSY` are codex rewriting its WAL database: a read-only connection
 * cannot create the `-shm` file codex just removed, or meets a checkpoint. It passes a moment later.
 */
function isTransientOpenError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && RETRYABLE_CODES.has(String((error as { code?: unknown }).code))
    );
}

/**
 * Every thread's projection parts in one database, or null when it has no `thread_items` table in
 * the shape the fingerprints need.
 */
function scanThreads(database: Database, databaseIndex: number): Record<string, ProjectionFingerprintPart[]> | null {
    const threads: Record<string, ProjectionFingerprintPart[]> = {};
    const push = (threadId: string, part: ProjectionFingerprintPart) => {
        const parts = threads[threadId] ?? [];
        parts.push(part);
        threads[threadId] = parts;
    };
    const columns = sqliteColumns(database, "thread_items");
    if (!columns.includes("thread_id") || !columns.includes("rollout_ordinal") || !columns.includes("item_json")) {
        return null;
    }

    if (columns.includes("updated_at_ordinal")) {
        // Two scans, each answered by an index alone (codex has `(thread_id, rollout_ordinal)` and
        // `(thread_id, updated_at_ordinal)`). One query needing both maxima read every table row, large
        // `item_json` included: a 559 MB database took 56 ms warm and up to 6.6 s cold, synchronously, in the
        // hub server (2026-10-08). The rows are identical; 12 ms warm.
        const revisions = new Map(
            (
                database
                    .query(
                        "SELECT thread_id, coalesce(max(updated_at_ordinal), 0) AS revision FROM thread_items GROUP BY thread_id"
                    )
                    .all() as Array<{ thread_id: unknown; revision: unknown }>
            ).map((row) => [row.thread_id, row.revision])
        );
        const rows = (
            database
                .query(
                    "SELECT thread_id, count(*) AS count, coalesce(max(rollout_ordinal), 0) AS ordinal FROM thread_items GROUP BY thread_id"
                )
                .all() as Array<Record<string, unknown>>
        )
            .map((row) => ({ ...row, revision: revisions.get(row.thread_id) ?? 0 }))
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

        return threads;
    }

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
        .query("SELECT thread_id, rollout_ordinal, item_json FROM thread_items ORDER BY thread_id, rollout_ordinal")
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

    return threads;
}

type ScanOutcome = { threads: Record<string, ProjectionFingerprintPart[]> | null } | { error: unknown };

function scanDatabase(open: ProjectionOpener, path: string, databaseIndex: number): ScanOutcome {
    let database: Database | undefined;
    try {
        database = open(path);
        return { threads: scanThreads(database, databaseIndex) };
    } catch (error) {
        return { error };
    } finally {
        database?.close();
    }
}

/**
 * Every thread's projection parts from a home's `thread_history*.sqlite` files, one pass per
 * database. The per-source read below opened each database and scanned `thread_items` once per
 * rollout: 364 rollouts on this machine meant 364 opens and 364 table scans, 550 ms of every
 * `tools ai usage sessions`. Grouped by thread the same rows are read once, and the parts a
 * thread gets are byte-identical to the per-source ones, so no stored fingerprint changes.
 *
 * A database codex is rewriting fails to open now and then (`SQLITE_CANTOPEN`, 142 warnings on
 * 2026-09-29). It is retried once after `retryDelayMs`; if it still fails, the last parts cached
 * for that path stand in, at debug level. Only a failure with nothing cached is an issue.
 */
export async function readCodexProjectionIndex(
    metadataPaths: readonly string[],
    onIssue: (path: string) => void,
    { open = (path) => new Database(path, { readonly: true }), retryDelayMs = 100 }: ReadCodexProjectionOptions = {}
): Promise<CodexProjectionIndex> {
    const index: CodexProjectionIndex = new Map();
    const paths = metadataPaths.filter((path) => /thread_history(?:_\d+)?\.sqlite$/.test(path));
    // Keyed by database path and stamped with the file's mtime and size (WAL included): a
    // listing while codex is idle reuses the parts and never opens the database, which was 230
    // to 300 ms per home for every `tools ai usage sessions` Genesis.app fires every 35 s.
    const cache = readProjectionCache();
    let dirty = false;
    const merge = (threads: Record<string, ProjectionFingerprintPart[]>, databaseIndex: number) => {
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
            merge(cached.threads, databaseIndex);
            continue;
        }

        let outcome = scanDatabase(open, path, databaseIndex);
        if ("error" in outcome && isTransientOpenError(outcome.error)) {
            logger.debug(
                { error: outcome.error, path, retryDelayMs },
                "[codex] projection database busy; retrying once"
            );
            await Bun.sleep(retryDelayMs);
            outcome = scanDatabase(open, path, databaseIndex);
        }

        if ("error" in outcome) {
            const previous = cache[path];
            // Only a transient lock falls back to the cache. A corrupt or wrong-format file
            // (`SQLITE_NOTADB`) is reported, not hidden behind stale parts.
            if (previous && isTransientOpenError(outcome.error)) {
                logger.debug(
                    { error: outcome.error, path, cachedStamp: previous.stamp },
                    "[codex] projection database unreadable; using the last cached parts"
                );
                merge(previous.threads, databaseIndex);
                continue;
            }

            logger.warn({ error: outcome.error, path }, "[codex] projection database unreadable");
            onIssue(path);
            continue;
        }

        if (outcome.threads === null) {
            continue;
        }

        merge(outcome.threads, databaseIndex);

        if (stamp !== undefined) {
            cache[path] = { stamp, threads: outcome.threads };
            dirty = true;
        }
    }

    if (dirty) {
        writeProjectionCache(cache);
    }

    return index;
}
