import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createKyselyClient, type DatabaseClient } from "@genesiscz/utils/database/client";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { FILE_META_MIGRATION_CONTEXT, FILE_META_MIGRATIONS } from "./file-meta-migrations";
import type { FileMetaDB } from "./file-meta-schema";
import {
    defaultExistsProbe,
    type ExistsProbe,
    type ListDir,
    PathPresence,
    readDirListing,
    type StatDir,
    statDirStamp,
} from "./path-presence";
import { clonesProfile } from "./profile";

const log = logger.child({ component: "clones:file-meta-cache" });

/** Single global path: any scan that walks a path looks up its cached metadata
 *  regardless of which root surrounded it. `~/Projects/Foo` then `~/Projects`
 *  reuses rows from the first scan. ONE db per machine, not per scan-root. */
export const FILE_META_DB_PATH = join(env.tools.getHome(), ".genesis-tools", "macos-clones", "cache", "file-meta.db");

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
export const PRUNE_TTL_DAYS = 30;
const PRUNE_TTL_MS = PRUNE_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Paths kept per removal reason for the run report. */
const REPORT_SAMPLES = 10;

/** A phase timer that always measures (the report needs the numbers) and also
 *  records into the `clones` profiler scope when `PROFILE=clones` is on. */
function startPhase(label: string): () => number {
    const startedAt = performance.now();
    const stopProfile = clonesProfile.start(label);
    return () => {
        stopProfile();
        return performance.now() - startedAt;
    };
}

type MetaTable = "file_meta" | "dir_meta";

/** Address space the sweep maps the cache file into (SQLite caps it at its own compile-time maximum). */
const SWEEP_MMAP_BYTES = 2 * 1024 * 1024 * 1024;

/** Gone rows deleted per transaction during the sweep. */
const DELETE_BATCH_ROWS = 5_000;

/** A dir_meta row as the sweep reads it: the stored stamp and children let `PathPresence` answer its children. */
interface SweepDirRow {
    path: string;
    dir_mtime_ns: bigint;
    ino: bigint;
    child_names_json: string;
}

/** One table's rows in path order, read a page at a time with keyset paging. */
class SortedRowCursor<Row extends { path: string }> {
    private page: Row[] = [];
    private index = 0;
    private exhausted = false;

    constructor(
        private readonly read: (after: string) => Promise<Row[]>,
        private readonly pageSize: number,
        private after: string
    ) {}

    needsPage(): boolean {
        return this.index >= this.page.length && !this.exhausted;
    }

    async fill(): Promise<void> {
        this.page = await this.read(this.after);
        this.index = 0;
        this.exhausted = this.page.length < this.pageSize;
        this.after = this.page[this.page.length - 1]?.path ?? this.after;
    }

    head(): Row | undefined {
        return this.page[this.index];
    }

    advance(): void {
        this.index += 1;
    }
}

/** Where a windowed reconcile resumes: after the last path the previous run checked ("" for the top), and which run
 *  of the cycle this is (0-based). */
interface ReconcileCursor {
    after: string;
    run: number;
}

function readReconcileCursor(path: string): ReconcileCursor {
    if (!existsSync(path)) {
        return { after: "", run: 0 };
    }

    try {
        const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        if (typeof raw === "object" && raw !== null && "after" in raw && typeof raw.after === "string") {
            const run = "run" in raw && typeof raw.run === "number" && raw.run >= 0 ? Math.floor(raw.run) : 0;
            return { after: raw.after, run };
        }
    } catch (err) {
        log.warn({ err, path }, "reconcile cursor unreadable; the window starts at the top");
    }

    return { after: "", run: 0 };
}

function writeReconcileCursor(path: string, cursor: ReconcileCursor): void {
    atomicWriteFileSync(path, `${SafeJSON.stringify({ ...cursor, savedAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Whether the reconcile VACUUMs, and the sentence that says why, for the run report. */
export function vacuumDecision(input: { deleted: number; rowsBefore: number; vacuumAtFraction: number }): {
    run: boolean;
    reason: string;
} {
    if (input.vacuumAtFraction <= 0) {
        return { run: false, reason: "VACUUM is off for this run" };
    }

    if (input.rowsBefore === 0) {
        return { run: false, reason: "the cache was empty" };
    }

    const fraction = input.deleted / input.rowsBefore;
    const removed = `${input.deleted} of ${input.rowsBefore} rows removed (${(fraction * 100).toFixed(2)}%)`;
    const threshold = `${(input.vacuumAtFraction * 100).toFixed(0)}% threshold`;

    if (fraction >= input.vacuumAtFraction) {
        return { run: true, reason: `${removed}, at or over the ${threshold}` };
    }

    return { run: false, reason: `${removed}, under the ${threshold}` };
}

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

export interface ReconcileOptions {
    nowMs?: number;
    /** Existence probe, injectable for tests. Default `existsSync`. */
    exists?: ExistsProbe;
    /** Directory lister, injectable for tests. Default `readdirSync` with entry types. With only `exists`
     *  injected, nothing is listed and every answer comes from `exists`. */
    listDir?: ListDir;
    /** Directory stat for the stored-children check, injectable for tests. Default `statSync` (bigint). With only
     *  `exists` injected, no stored children are trusted. */
    statDir?: StatDir;
    /** Rows fetched per page while sweeping for gone paths. */
    pageSize?: number;
    /** VACUUM when at least this fraction of rows was deleted (0 = never). */
    vacuumAtFraction?: number;
    /** Check only the next 1/`windowRuns` of the rows in path order, starting where the previous run stopped (the
     *  cursor file), so every row is checked once per `windowRuns` runs. 1 (default) checks every row. */
    windowRuns?: number;
    /** Where the window cursor is kept. Default: next to the DB, `<db>.reconcile-cursor.json`. */
    cursorPath?: string;
}

/** The part of the rows one windowed run checked. */
export interface ReconcileWindow {
    runs: number;
    /** The run started after this path ("" = the first row). */
    from: string;
    /** The next run starts after this path; null when this run reached the last row (the next starts at the top). */
    to: string | null;
}

/** The reconcile phases, in run order, then the sweep split into its row reads, its existence checks (listings
 *  and probes) and its deletes. */
export const RECONCILE_PHASE_KEYS = [
    "countMs",
    "ttlMs",
    "sweepMs",
    "vacuumMs",
    "readMs",
    "probeMs",
    "deleteMs",
] as const;

/** Milliseconds per reconcile phase. */
export type ReconcilePhases = Record<(typeof RECONCILE_PHASE_KEYS)[number], number>;

export interface ReconcileReport {
    rowsBefore: number;
    rowsAfter: number;
    fileRows: number;
    dirRows: number;
    staleFiles: number;
    staleDirs: number;
    goneFiles: number;
    goneDirs: number;
    /** `existsSync` probes issued: only the rows a parent's listing could not settle. */
    probes: number;
    /** Directory listings taken: parents with no stored children, or whose stamp changed since the scan. */
    listings: number;
    /** Parent directories `stat`ed to compare with their stored stamp. */
    stamps: number;
    /** Parents answered from their stored children (the stamp still matched). */
    storedHits: number;
    /** Rows whose path this run checked (all rows, or this run's window). */
    checked: number;
    window: ReconcileWindow;
    /** Up to ten removed paths per reason. */
    samples: { staleFiles: string[]; staleDirs: string[]; goneFiles: string[]; goneDirs: string[] };
    vacuumed: boolean;
    /** Why the reconcile did or did not VACUUM. */
    vacuumReason: string;
    elapsedMs: number;
    phases: ReconcilePhases;
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

    /** The daily reconciliation, for the daemon. One pass over BOTH tables,
     *  then an optional VACUUM:
     *
     *  1. TTL over the whole table. `pruneScope` / `pruneDirScope` only see the
     *     roots of the scan that ran, so a tree that is never scanned again
     *     keeps its rows forever (1.47M dir_meta rows / 1.37 GB on the first
     *     machine this ran on, all from one day of fleet walks).
     *  2. Gone paths. The rows of both tables are merged in path order and
     *     each is answered once per parent directory (`PathPresence`) instead
     *     of one `stat` per row: 976,810 rows under about 330,000 parents on
     *     2026-10-12. A parent whose `stat` still shows the mtime and inode its
     *     dir_meta row stored answers from the stored children, the rule the
     *     scan itself uses to skip `readdir`; any other parent is listed. A row
     *     is only removed when `existsSync` calls it gone, or when its parent's
     *     `stat` finds the parent gone: every case the cheap answer cannot
     *     settle falls back to the probe the old sweep made.
     *
     *  Stale-but-present rows are harmless for correctness (the size/mtime and
     *  dir mtime/ino checks catch divergence), so this exists only to keep the
     *  file bounded. Never called from a scan. */
    async reconcile(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
        const { kysely } = this.getClient();
        const sw = new Stopwatch();
        const nowMs = opts.nowMs ?? Date.now();
        const exists = opts.exists ?? defaultExistsProbe;
        // An injected `exists` alone (the tests' fake paths) answers every question: no real directory is listed.
        const listDir = opts.listDir ?? (opts.exists ? () => null : readDirListing);
        const statDir = opts.statDir ?? (opts.exists ? undefined : statDirStamp);
        const pageSize = opts.pageSize ?? 5000;
        const vacuumAtFraction = opts.vacuumAtFraction ?? 0.1;
        const cutoff = BigInt(nowMs - PRUNE_TTL_MS);
        const phases: ReconcilePhases = {
            countMs: 0,
            ttlMs: 0,
            sweepMs: 0,
            vacuumMs: 0,
            readMs: 0,
            probeMs: 0,
            deleteMs: 0,
        };

        const countRows = async (table: MetaTable): Promise<number> => {
            const r = await kysely
                .selectFrom(table)
                .select((eb) => eb.fn.countAll<number>().as("n"))
                .executeTakeFirst();
            return Number(r?.n ?? 0);
        };
        const stopCount = startPhase("reconcile.count");
        const fileRows = await countRows("file_meta");
        const dirRows = await countRows("dir_meta");
        phases.countMs = stopCount();
        const rowsBefore = fileRows + dirRows;
        log.info(
            { event: "cache.reconcile.start", rowsBefore, fileRows, dirRows, cutoff: Number(cutoff) },
            "FileMetaCache reconcile start"
        );

        const stopTtl = startPhase("reconcile.ttl");
        const staleSample = async (table: MetaTable): Promise<string[]> => {
            const rows = await kysely
                .selectFrom(table)
                .select("path")
                .where("last_seen_at", "<", cutoff)
                .limit(REPORT_SAMPLES)
                .execute();
            return rows.map((row) => row.path);
        };
        const samples: ReconcileReport["samples"] = {
            staleFiles: await staleSample("file_meta"),
            staleDirs: await staleSample("dir_meta"),
            goneFiles: [],
            goneDirs: [],
        };
        const staleFilesRes = await kysely
            .deleteFrom("file_meta")
            .where("last_seen_at", "<", cutoff)
            .executeTakeFirst();
        const staleDirsRes = await kysely.deleteFrom("dir_meta").where("last_seen_at", "<", cutoff).executeTakeFirst();
        const staleFiles = Number(staleFilesRes.numDeletedRows ?? 0n);
        const staleDirs = Number(staleDirsRes.numDeletedRows ?? 0n);
        for (const [path, entry] of this.mem) {
            if (BigInt(entry.lastSeenAt) < cutoff) {
                this.mem.delete(path);
            }
        }

        for (const [path, entry] of this.dirMem) {
            if (BigInt(entry.lastSeenAt) < cutoff) {
                this.dirMem.delete(path);
            }
        }

        phases.ttlMs = stopTtl();

        // Which folders hold rows, from the paths alone (two index-only scans): it lets a chain folder skip its stat.
        const stopSweep = startPhase("reconcile.sweep");
        const presence = new PathPresence({ exists, listDir, statDir });
        // Raw prepared statements: a million rows go through these, so the query builder's per-page work is skipped.
        const { raw } = this.getClient();
        // The sweep reads the whole file once; mapped pages skip a read() and a copy per 4 KB page.
        raw.exec(`PRAGMA mmap_size = ${SWEEP_MMAP_BYTES}`);
        const filePage = raw.query<{ path: string }, [string, number]>(
            "SELECT path FROM file_meta WHERE path > ? ORDER BY path LIMIT ?"
        );
        const dirPage = raw.query<SweepDirRow, [string, number]>(
            "SELECT path, dir_mtime_ns, ino, child_names_json FROM dir_meta WHERE path > ? ORDER BY path LIMIT ?"
        );
        const readFilePage = async (after: string): Promise<Array<{ path: string }>> => {
            const mark = performance.now();
            const page = filePage.all(after, pageSize);
            phases.readMs += performance.now() - mark;
            return page;
        };
        const readDirPage = async (after: string): Promise<SweepDirRow[]> => {
            const mark = performance.now();
            const page = dirPage.all(after, pageSize);
            phases.readMs += performance.now() - mark;
            return page;
        };
        const deleteGone = async (table: MetaTable, paths: string[]): Promise<void> => {
            if (paths.length === 0) {
                return;
            }

            const mark = performance.now();
            await kysely.transaction().execute(async (trx) => {
                for (let i = 0; i < paths.length; i += 500) {
                    await trx
                        .deleteFrom(table)
                        .where("path", "in", paths.slice(i, i + 500))
                        .execute();
                }
            });

            for (const path of paths) {
                if (table === "dir_meta") {
                    this.dirMem.delete(path);
                } else {
                    this.mem.delete(path);
                }
            }

            phases.deleteMs += performance.now() - mark;
        };
        const windowRuns = Math.max(1, Math.floor(opts.windowRuns ?? 1));
        const cursorPath = opts.cursorPath ?? `${this.dbPath}.reconcile-cursor.json`;
        const cursor = windowRuns > 1 ? readReconcileCursor(cursorPath) : { after: "", run: 0 };
        const from = cursor.after;
        // The rows still ahead, shared over the runs left in the cycle; the last run takes whatever is left, so a
        // cycle is always `windowRuns` runs however many rows the earlier ones removed.
        const runsLeft = windowRuns - Math.min(cursor.run, windowRuns - 1);
        const budget = runsLeft > 1 ? Math.ceil(this.countRowsAfter(from) / runsLeft) : Number.POSITIVE_INFINITY;
        const files = new SortedRowCursor(readFilePage, pageSize, from);
        const dirs = new SortedRowCursor(readDirPage, pageSize, from);
        const deadFiles: string[] = [];
        const deadDirs: string[] = [];
        let goneFiles = 0;
        let goneDirs = 0;
        let checked = 0;
        let lastChecked = from;
        let to: string | null = null;

        for (;;) {
            if (checked >= budget) {
                to = lastChecked;
                break;
            }

            if (files.needsPage()) {
                await files.fill();
            }

            if (dirs.needsPage()) {
                await dirs.fill();
            }

            const file = files.head()?.path;
            const dir = dirs.head();

            // Both tables merged in path order, so one answer for a parent serves its files and its subdirectories.
            if (file !== undefined && (dir === undefined || file < dir.path)) {
                files.advance();
                checked += 1;
                lastChecked = file;
                if (!presence.fileExists(file)) {
                    deadFiles.push(file);
                    if (samples.goneFiles.length < REPORT_SAMPLES) {
                        samples.goneFiles.push(file);
                    }
                }
            } else if (dir !== undefined) {
                dirs.advance();
                checked += 1;
                lastChecked = dir.path;
                if (presence.dirExists(dir.path)) {
                    presence.offerStored(dir.path, {
                        mtimeNs: dir.dir_mtime_ns,
                        ino: dir.ino,
                        childNamesJson: dir.child_names_json,
                    });
                } else {
                    deadDirs.push(dir.path);
                    if (samples.goneDirs.length < REPORT_SAMPLES) {
                        samples.goneDirs.push(dir.path);
                    }
                }
            } else {
                break;
            }

            if (deadFiles.length >= DELETE_BATCH_ROWS) {
                goneFiles += deadFiles.length;
                await deleteGone("file_meta", deadFiles.splice(0));
            }

            if (deadDirs.length >= DELETE_BATCH_ROWS) {
                goneDirs += deadDirs.length;
                await deleteGone("dir_meta", deadDirs.splice(0));
            }
        }

        goneFiles += deadFiles.length;
        goneDirs += deadDirs.length;
        await deleteGone("file_meta", deadFiles);
        await deleteGone("dir_meta", deadDirs);
        raw.exec("PRAGMA mmap_size = 0");
        if (windowRuns > 1) {
            writeReconcileCursor(cursorPath, to === null ? { after: "", run: 0 } : { after: to, run: cursor.run + 1 });
        }

        phases.sweepMs = stopSweep();
        phases.probeMs = phases.sweepMs - phases.readMs - phases.deleteMs;

        const deleted = staleFiles + staleDirs + goneFiles + goneDirs;
        const vacuum = vacuumDecision({ deleted, rowsBefore, vacuumAtFraction });
        if (vacuum.run) {
            const stopVacuum = startPhase("reconcile.vacuum");
            this.getClient().raw.exec("VACUUM");
            phases.vacuumMs = stopVacuum();
        }

        for (const key of RECONCILE_PHASE_KEYS) {
            phases[key] = Math.round(phases[key]);
        }

        const report: ReconcileReport = {
            rowsBefore,
            rowsAfter: rowsBefore - deleted,
            fileRows,
            dirRows,
            staleFiles,
            staleDirs,
            goneFiles,
            goneDirs,
            probes: presence.probes,
            listings: presence.listings,
            stamps: presence.stamps,
            storedHits: presence.storedHits,
            checked,
            window: { runs: windowRuns, from, to },
            samples,
            vacuumed: vacuum.run,
            vacuumReason: vacuum.reason,
            elapsedMs: Math.round(sw.elapsedMs),
            phases,
        };
        log.info({ event: "cache.reconcile.complete", ...report }, "FileMetaCache reconcile complete");
        return report;
    }

    /** Rows of both tables whose path sorts after `after` (an index-only count). */
    private countRowsAfter(after: string): number {
        const { raw } = this.getClient();
        let total = 0;

        for (const table of ["file_meta", "dir_meta"] as const) {
            const row = raw
                .query<{ n: number | bigint }, [string]>(`SELECT count(*) AS n FROM ${table} WHERE path > ?`)
                .get(after);
            total += Number(row?.n ?? 0);
        }

        return total;
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
