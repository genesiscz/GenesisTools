import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@app/logger";
import { createKyselyClient, type DatabaseClient } from "@app/utils/database/client";
import { SafeJSON } from "@app/utils/json";
import { Stopwatch } from "@app/utils/Stopwatch";
import { FILE_META_MIGRATION_CONTEXT, FILE_META_MIGRATIONS } from "./file-meta-migrations";
import type { FileMetaDB } from "./file-meta-schema";

const log = logger.child({ component: "clones:file-meta-cache" });

/** Single global path: any scan that walks a path looks up its cached metadata
 *  regardless of which root surrounded it. `~/Projects/Foo` then `~/Projects`
 *  reuses rows from the first scan. ONE db per machine, not per scan-root. */
export const FILE_META_DB_PATH = join(homedir(), ".genesis-tools", "macos-clones", "cache", "file-meta.db");

/** SQLite caps bound parameters at 32766 (SQLITE_MAX_VARIABLE_NUMBER since
 *  3.32.0). Our flush rows have 6 columns, so 32766 / 6 = 5461 is the hard
 *  cap. Using 5000 leaves headroom and rounds nicely. */
const FLUSH_BATCH_ROWS = 5_000;

/** Time-to-live for cached rows. After this much time without a refresh (i.e.
 *  the file was never set() again — meaning it either vanished from disk or
 *  changed content so a new row replaced it… but kept its old `last_seen_at`
 *  because cache *hits* don't bump the timestamp), we garbage-collect the row.
 *
 *  Stale rows are HARMLESS for correctness — the (size, mtime_ns) hit check
 *  catches divergence and re-hashes. The TTL exists purely to keep the DB
 *  from growing unboundedly on heavy-churn trees (e.g. dev directories where
 *  `dist/` regenerates every build).
 *
 *  30 days is conservative: short enough to GC dev churn, long enough that
 *  someone who scans monthly still sees a hot cache. */
const PRUNE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface FileMetaEntry {
    size: bigint;
    mtimeNs: bigint;
    sha256: string;
    /** First-4 KB sha256 (lowercase hex). Empty string when the row was
     *  written before the P3 prefix-hash column landed OR by a writer that
     *  didn't compute it. The detector treats missing/"" as "not cached,
     *  recompute". Optional so older test fakes and pre-P3 callers don't
     *  need to know about it. */
    prefixHash?: string;
    /** APFS clone-family id, lowercase hex; empty string for files without one. */
    cloneId: string;
    /** Epoch-ms timestamp of the scan that last touched this row. */
    lastSeenAt: number;
}

export type DirChildKind = "file" | "dir" | "symlink";

export interface DirChild {
    name: string;
    kind: DirChildKind;
}

export interface DirMetaEntry {
    dirMtimeNs: bigint;
    ino: bigint;
    childNames: DirChild[];
    lastSeenAt: number;
}

/** Writable cache database for per-file (size, mtime_ns, sha256, clone_id)
 *  metadata. Used by `findDuplicateFiles` to skip re-hashing unchanged files
 *  across runs.
 *
 *  - **Singleton.** SQLite WAL allows multiple connections, but in-process two
 *    instances would fork their in-memory `mem` Map and lose writes from each
 *    other. `getInstance()` enforces one live instance per process. Tests
 *    swap via `resetForTests()`.
 *  - **Bulk load.** `loadScope(root)` pulls every row under `root` from the
 *    PK btree (one prefix-range query) into `mem`. No per-file SQL during
 *    the walk.
 *  - **Bulk flush.** `flush()` writes every dirty row in one transactional
 *    `INSERT … ON CONFLICT DO UPDATE`.
 *  - **Scoped prune.** `pruneScope(root, cutoff)` deletes rows whose
 *    `last_seen_at < cutoff` AND whose path is under `root`. Other roots in
 *    the same db are left untouched.
 *
 *  Safety: the cache only speeds up *detection*. The `dedupeFile` safety
 *  contract (`bytesEqualStreaming` before `cloneFile`) still re-verifies
 *  byte equality, so a stale cache row can at worst cost one extra byte
 *  compare — never an incorrect dedupe. */
export class FileMetaCache {
    private static instance: FileMetaCache | null = null;

    private client: DatabaseClient<FileMetaDB> | null = null;
    private readonly mem = new Map<string, FileMetaEntry>();
    private readonly dirty = new Set<string>();
    private readonly dirMem = new Map<string, DirMetaEntry>();
    private readonly dirDirty = new Set<string>();

    private constructor(private readonly dbPath: string) {}

    /** Get or create the singleton. Passing a different path while an instance
     *  exists throws — call `close()` on the previous one first. Tests use
     *  `resetForTests()` to swap. */
    static getInstance(dbPath: string = FILE_META_DB_PATH): FileMetaCache {
        if (FileMetaCache.instance) {
            if (FileMetaCache.instance.dbPath !== dbPath) {
                throw new Error(
                    `FileMetaCache already open at ${FileMetaCache.instance.dbPath}; ` +
                        `cannot also open at ${dbPath}. Call close() first.`
                );
            }
            return FileMetaCache.instance;
        }
        FileMetaCache.instance = new FileMetaCache(dbPath);
        return FileMetaCache.instance;
    }

    /** For tests only. Closes any prior instance and creates a fresh one at
     *  `dbPath`. Production code must not call this. */
    static resetForTests(dbPath: string): FileMetaCache {
        FileMetaCache.instance?.close();
        FileMetaCache.instance = new FileMetaCache(dbPath);
        return FileMetaCache.instance;
    }

    private getClient(): DatabaseClient<FileMetaDB> {
        if (!this.client) {
            const sw = new Stopwatch();
            this.client = createKyselyClient<FileMetaDB>({
                path: this.dbPath,
                migrations: FILE_META_MIGRATIONS,
                migrationContext: FILE_META_MIGRATION_CONTEXT,
                pragmas: { journalMode: "WAL", synchronous: "NORMAL" },
                // APFS mtime_ns (~1.78e18) > Number.MAX_SAFE_INTEGER (2^53).
                // Without this, the bigint → number cast in bun:sqlite drops
                // precision and `cached.mtimeNs === fresh.mtimeNs` mis-fires
                // — defeating the whole cache.
                safeIntegers: true,
            });
            log.info(
                { event: "cache.opened", dbPath: this.dbPath, openMs: Math.round(sw.elapsedMs) },
                "FileMetaCache opened"
            );
        }
        return this.client;
    }

    /** Compute the [lo, hi) prefix range for paths under `root`. Uses the
     *  next-character trick so the hi bound is exclusive and the query still
     *  walks the PK btree (no full-table scan). */
    private static prefixRange(root: string): { lo: string; hi: string } {
        const lo = root.endsWith("/") ? root : `${root}/`;
        const lastChar = lo.charCodeAt(lo.length - 1);
        const hi = `${lo.slice(0, -1)}${String.fromCharCode(lastChar + 1)}`;
        return { lo, hi };
    }

    /** For dir-meta: the root directory itself IS a row in the table, AND
     *  its child directories live under `root + "/"`. Returns the exact
     *  path AND the children-prefix range. A pure single range can't
     *  discriminate `/foo` (the root) from `/foobar` (a sibling) — so we
     *  filter with `(path = exact OR (path >= childLo AND path < childHi))`. */
    private static dirPathFilter(root: string): { exact: string; childLo: string; childHi: string } {
        const exact = root.endsWith("/") ? root.slice(0, -1) : root;
        const childLo = `${exact}/`;
        const lastChar = childLo.charCodeAt(childLo.length - 1);
        const childHi = `${childLo.slice(0, -1)}${String.fromCharCode(lastChar + 1)}`;
        return { exact, childLo, childHi };
    }

    /** Bulk-load rows under `root` into the in-memory `mem` Map via one
     *  prefix-range query against the PK btree. Repeated calls accumulate.
     *
     *  Kysely's `execute()` is always async (even when the underlying driver
     *  is sync) — callers must `await` it. */
    async loadScope(root: string): Promise<void> {
        const { kysely } = this.getClient();
        const sw = new Stopwatch();
        const { lo, hi } = FileMetaCache.prefixRange(root);
        log.info({ event: "cache.load.start", root, lo, hi }, "FileMetaCache loadScope start");

        const rows = await kysely
            .selectFrom("file_meta")
            .select(["path", "size", "mtime_ns", "sha256", "prefix_hash", "clone_id", "last_seen_at"])
            .where("path", ">=", lo)
            .where("path", "<", hi)
            .execute();

        // Skip rows whose path is in `dirty` — those have in-memory writes
        // from this scan that haven't been flushed yet. A second loadScope
        // call (e.g. CLI passing multiple roots that overlap a stale DB row)
        // would otherwise clobber the newer in-memory entry with stale data.
        let skipped = 0;
        for (const r of rows) {
            if (this.dirty.has(r.path)) {
                skipped += 1;
                continue;
            }

            this.mem.set(r.path, {
                size: r.size,
                mtimeNs: r.mtime_ns,
                sha256: r.sha256,
                prefixHash: r.prefix_hash,
                cloneId: r.clone_id,
                lastSeenAt: Number(r.last_seen_at),
            });
        }
        log.info(
            {
                event: "cache.load.complete",
                root,
                rows: rows.length,
                skippedDirty: skipped,
                loadMs: Math.round(sw.elapsedMs),
            },
            "FileMetaCache loadScope complete"
        );
    }

    get(path: string): FileMetaEntry | null {
        return this.mem.get(path) ?? null;
    }

    set(path: string, entry: FileMetaEntry): void {
        this.mem.set(path, entry);
        this.dirty.add(path);
    }

    /** Bulk-write dirty rows. Kysely emits one multi-row INSERT per batch;
     *  we chunk because SQLite caps bound parameters at 32766 and we use 6
     *  columns per row (32766/6 = 5461). `lastSeenAt` is stamped on every
     *  dirty row so a follow-up `pruneScope(cutoff)` drops rows whose files
     *  weren't seen this run. */
    async flush(lastSeenAt: number): Promise<void> {
        if (this.dirty.size === 0) {
            log.info({ event: "cache.flush.skip", reason: "no-dirty" }, "FileMetaCache flush skipped (clean)");
            return;
        }
        const { kysely } = this.getClient();
        const sw = new Stopwatch();
        const lastSeenBig = BigInt(lastSeenAt);
        const rows = [...this.dirty].flatMap((path) => {
            const e = this.mem.get(path);
            if (!e) {
                return [];
            }
            return [
                {
                    path,
                    size: e.size,
                    mtime_ns: e.mtimeNs,
                    sha256: e.sha256,
                    prefix_hash: e.prefixHash ?? "",
                    clone_id: e.cloneId,
                    last_seen_at: lastSeenBig,
                },
            ];
        });

        log.info(
            { event: "cache.flush.start", rows: rows.length, batchSize: FLUSH_BATCH_ROWS },
            "FileMetaCache flush start"
        );

        let batchIndex = 0;
        for (let i = 0; i < rows.length; i += FLUSH_BATCH_ROWS) {
            const batch = rows.slice(i, i + FLUSH_BATCH_ROWS);
            batchIndex += 1;
            await kysely
                .insertInto("file_meta")
                .values(batch)
                .onConflict((oc) =>
                    oc.column("path").doUpdateSet((eb) => ({
                        size: eb.ref("excluded.size"),
                        mtime_ns: eb.ref("excluded.mtime_ns"),
                        sha256: eb.ref("excluded.sha256"),
                        prefix_hash: eb.ref("excluded.prefix_hash"),
                        clone_id: eb.ref("excluded.clone_id"),
                        last_seen_at: eb.ref("excluded.last_seen_at"),
                    }))
                )
                .execute();
            if (batchIndex % 4 === 0 || i + FLUSH_BATCH_ROWS >= rows.length) {
                log.info(
                    {
                        event: "cache.flush.progress",
                        batch: batchIndex,
                        written: Math.min(i + FLUSH_BATCH_ROWS, rows.length),
                        total: rows.length,
                    },
                    "FileMetaCache flush progress"
                );
            }
        }

        for (const path of this.dirty) {
            const e = this.mem.get(path);
            if (e) {
                e.lastSeenAt = lastSeenAt;
            }
        }
        log.info(
            {
                event: "cache.flush.complete",
                rows: rows.length,
                batches: batchIndex,
                flushMs: Math.round(sw.elapsedMs),
            },
            "FileMetaCache flush complete"
        );
        this.dirty.clear();
    }

    /** Garbage-collect cached rows older than PRUNE_TTL_MS within `root`.
     *
     *  CRITICAL FIX vs. the original implementation: pruning by
     *  `last_seen_at < scanStartedAt` (the previous design) deleted every
     *  cache HIT on every warm run, because hits don't refresh
     *  `last_seen_at` — the timestamp only gets written when a `set()` (i.e.
     *  a miss) happens. That meant alternating warm/cold every other run.
     *
     *  TTL-based pruning is correct: stale rows are harmless for correctness
     *  (the (size, mtime_ns) check catches divergence and re-hashes), so the
     *  only purpose of prune is bounded DB growth. 30 days is the cutoff. */
    async pruneScope(root: string, nowMs: number): Promise<void> {
        const { kysely } = this.getClient();
        const sw = new Stopwatch();
        const cutoff = nowMs - PRUNE_TTL_MS;
        const { lo, hi } = FileMetaCache.prefixRange(root);
        log.info(
            { event: "cache.prune.start", root, nowMs, cutoff, ttlDays: PRUNE_TTL_MS / 86_400_000, lo, hi },
            "FileMetaCache pruneScope start"
        );

        const res = await kysely
            .deleteFrom("file_meta")
            .where("last_seen_at", "<", BigInt(cutoff))
            .where("path", ">=", lo)
            .where("path", "<", hi)
            .executeTakeFirst();

        // Drop matching entries from the in-memory map too, otherwise a later
        // get(path) would return a row the DB no longer has.
        for (const [path, entry] of this.mem) {
            if (path >= lo && path < hi && entry.lastSeenAt < cutoff) {
                this.mem.delete(path);
            }
        }
        log.info(
            {
                event: "cache.prune.complete",
                root,
                pruned: Number(res.numDeletedRows ?? 0n),
                pruneMs: Math.round(sw.elapsedMs),
            },
            "FileMetaCache pruneScope complete"
        );
    }

    // ─────────────────────────── dir-meta API (Phase 10) ─────────────────────
    //
    // Parallel to the file-meta methods. Different table (`dir_meta`), same
    // SQLite client, same WAL, same TTL prune. Used by `walkFiles` to skip
    // `readdirSync` on directories whose `(dir_mtime_ns, ino)` haven't
    // changed since the last scan (POSIX 1003.1-2001 §4.7 — namespace
    // changes are the ONLY source of directory mtime bumps).

    async loadDirScope(root: string): Promise<void> {
        const { kysely } = this.getClient();
        const sw = new Stopwatch();
        const { exact, childLo, childHi } = FileMetaCache.dirPathFilter(root);
        log.info({ event: "dir.load.start", root, exact, childLo, childHi }, "FileMetaCache loadDirScope start");

        const rows = await kysely
            .selectFrom("dir_meta")
            .select(["path", "dir_mtime_ns", "ino", "child_names_json", "last_seen_at"])
            .where((eb) =>
                eb.or([eb("path", "=", exact), eb.and([eb("path", ">=", childLo), eb("path", "<", childHi)])])
            )
            .execute();

        let skipped = 0;
        for (const r of rows) {
            if (this.dirDirty.has(r.path)) {
                skipped += 1;
                continue;
            }

            this.dirMem.set(r.path, {
                dirMtimeNs: r.dir_mtime_ns,
                ino: r.ino,
                childNames: SafeJSON.parse(r.child_names_json) as DirChild[],
                lastSeenAt: Number(r.last_seen_at),
            });
        }
        log.info(
            {
                event: "dir.load.complete",
                root,
                rows: rows.length,
                skippedDirty: skipped,
                loadMs: Math.round(sw.elapsedMs),
            },
            "FileMetaCache loadDirScope complete"
        );
    }

    getDir(path: string): DirMetaEntry | null {
        return this.dirMem.get(path) ?? null;
    }

    setDir(path: string, entry: DirMetaEntry): void {
        this.dirMem.set(path, entry);
        this.dirDirty.add(path);
    }

    /** Bulk-write dirty dir rows in batches of FLUSH_BATCH_ROWS. Five columns
     *  per row, so the same 5000-row chunk size used for file_meta works
     *  here too (5 × 5000 = 25,000 params, well under the 32,766 cap). */
    async flushDir(lastSeenAt: number): Promise<void> {
        if (this.dirDirty.size === 0) {
            log.info({ event: "dir.flush.skip", reason: "no-dirty" }, "FileMetaCache flushDir skipped (clean)");
            return;
        }
        const { kysely } = this.getClient();
        const sw = new Stopwatch();
        const lastSeenBig = BigInt(lastSeenAt);
        const rows = [...this.dirDirty].flatMap((path) => {
            const e = this.dirMem.get(path);
            if (!e) {
                return [];
            }
            return [
                {
                    path,
                    dir_mtime_ns: e.dirMtimeNs,
                    ino: e.ino,
                    child_names_json: SafeJSON.stringify(e.childNames),
                    last_seen_at: lastSeenBig,
                },
            ];
        });

        log.info(
            { event: "dir.flush.start", rows: rows.length, batchSize: FLUSH_BATCH_ROWS },
            "FileMetaCache flushDir start"
        );

        let batchIndex = 0;
        for (let i = 0; i < rows.length; i += FLUSH_BATCH_ROWS) {
            const batch = rows.slice(i, i + FLUSH_BATCH_ROWS);
            batchIndex += 1;
            await kysely
                .insertInto("dir_meta")
                .values(batch)
                .onConflict((oc) =>
                    oc.column("path").doUpdateSet((eb) => ({
                        dir_mtime_ns: eb.ref("excluded.dir_mtime_ns"),
                        ino: eb.ref("excluded.ino"),
                        child_names_json: eb.ref("excluded.child_names_json"),
                        last_seen_at: eb.ref("excluded.last_seen_at"),
                    }))
                )
                .execute();
        }

        for (const path of this.dirDirty) {
            const e = this.dirMem.get(path);
            if (e) {
                e.lastSeenAt = lastSeenAt;
            }
        }
        log.info(
            {
                event: "dir.flush.complete",
                rows: rows.length,
                batches: batchIndex,
                flushMs: Math.round(sw.elapsedMs),
            },
            "FileMetaCache flushDir complete"
        );
        this.dirDirty.clear();
    }

    /** TTL-based prune for dir_meta. Same 30-day window as pruneScope.
     *  Stale rows are harmless for correctness — the (dir_mtime_ns, ino)
     *  hit check catches divergence and triggers a fresh readdirSync. */
    async pruneDirScope(root: string, nowMs: number): Promise<void> {
        const { kysely } = this.getClient();
        const sw = new Stopwatch();
        const cutoff = nowMs - PRUNE_TTL_MS;
        const { exact, childLo, childHi } = FileMetaCache.dirPathFilter(root);
        log.info(
            {
                event: "dir.prune.start",
                root,
                nowMs,
                cutoff,
                ttlDays: PRUNE_TTL_MS / 86_400_000,
                exact,
                childLo,
                childHi,
            },
            "FileMetaCache pruneDirScope start"
        );

        const res = await kysely
            .deleteFrom("dir_meta")
            .where("last_seen_at", "<", BigInt(cutoff))
            .where((eb) =>
                eb.or([eb("path", "=", exact), eb.and([eb("path", ">=", childLo), eb("path", "<", childHi)])])
            )
            .executeTakeFirst();

        for (const [path, entry] of this.dirMem) {
            if (entry.lastSeenAt < cutoff && (path === exact || (path >= childLo && path < childHi))) {
                this.dirMem.delete(path);
            }
        }
        log.info(
            {
                event: "dir.prune.complete",
                root,
                pruned: Number(res.numDeletedRows ?? 0n),
                pruneMs: Math.round(sw.elapsedMs),
            },
            "FileMetaCache pruneDirScope complete"
        );
    }

    close(): void {
        this.client?.close();
        this.client = null;
        if (FileMetaCache.instance === this) {
            FileMetaCache.instance = null;
        }
    }

    /** Diagnostics: number of paths in the in-memory file-meta cache. */
    size(): number {
        return this.mem.size;
    }

    /** Diagnostics: number of paths in the in-memory dir-meta cache. */
    dirSize(): number {
        return this.dirMem.size;
    }
}
