import type { Database } from "bun:sqlite";
import { readdirSync, unlinkSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { dbBytes, duRunGone, freeBytesAt, getMeta, openIndexDbForWrite, setMeta, sweepDeadScans } from "./db";
import { DIR_FLAGS, SCHEMA_VERSION } from "./schema";
import {
    canonicalDir,
    canonicalPath,
    countBlocked,
    finishScan,
    gcTombstones,
    insertBigFiles,
    prepareUpsert,
    startScan,
    upsertNode,
    withIndexLock,
} from "./store";
import type { BuildResult, IndexEvent, ProgressEvent } from "./types";
import { IndexError } from "./types";
import { sameVolume, volumeUuidAt } from "./volume";
import { runIndexWalk, type WalkNode, type WalkOutput, type WalkProgress } from "./walk";

const log = logger.child({ component: "du:index:build" });

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const INDEX_DEFAULTS = {
    minDirBytes: 1 * MiB,
    bigFileFloor: 8 * MiB,
    bigFileLimit: 50_000,
    snapshotFloor: 64 * MiB,
    keepDaily: 14,
    keepWeekly: 8,
    toolVersion: "0.1.0",
} as const;

export interface BuildOptions {
    db: string;
    root: string;
    threads?: number;
    minDirBytes?: number;
    bigFileFloor?: number;
    bigFileLimit?: number;
    private?: boolean;
    excludes?: string[];
    includeCloud?: boolean;
    snapshot?: boolean;
    snapshotFloor?: number;
    /** Drop every row first. Needed to point an existing database at another root. */
    reset?: boolean;
    minFreeBytes?: number;
    /** Give up a folder whose listing makes no progress for this many seconds (default 10; 0 = never). */
    stallSeconds?: number;
    /** Extra environment for the C walker (tests only). */
    walkEnv?: Record<string, string>;
    /** How long to wait for another build or update before failing with `locked` (default 1000 ms). */
    lockWaitMs?: number;
    signal?: AbortSignal;
    emit?: (event: IndexEvent) => void;
    now?: () => number;
}

/** The kernel stops scaling near 8 walker threads (benchmarks-du.md), so more only burns CPU. */
export function defaultBuildThreads(): number {
    return Math.max(1, Math.min(8, availableParallelism()));
}

export function progressEvent(p: WalkProgress): ProgressEvent {
    return {
        type: "progress",
        phase: "walk",
        files: p.files,
        dirs: p.dirs,
        bytes: p.bytes,
        elapsed_ms: p.elapsed_ms,
        files_per_s: p.elapsed_ms > 0 ? Math.round((p.files * 1000) / p.elapsed_ms) : 0,
        dir: p.dir,
    };
}

/** Throttled to at most two lines per second, so the app's main queue is never flooded. */
export const PROGRESS_MIN_INTERVAL_MS = 450;

/**
 * The free space a build or update needs: room for the database to be written
 * twice over (the WAL holds a full copy of the rows during the swap) plus slack,
 * and never less than 1 GiB, the doctor's scan gate. A fixed 8 GiB refused to run
 * exactly when a nearly full disk made the index most useful.
 */
export function defaultMinFreeBytes(dbBytes: number): number {
    return Math.max(GiB, 2 * dbBytes + 256 * MiB);
}

export function assertDiskFree(dbPath: string, minFreeBytes: number): void {
    const free = freeBytesAt(dbPath);
    if (free < minFreeBytes) {
        throw new IndexError(
            "disk_low",
            `Only ${(free / GiB).toFixed(1)} GiB free on the volume of ${dbPath}; the index needs ${(minFreeBytes / GiB).toFixed(1)} GiB. Free some space first.`
        );
    }
}

/** The extent cache writes `<file>.tmp.<pid>` and renames; a killed scan leaves the temp file behind. */
export function sweepOrphanTempFiles(dir: string): number {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch (err) {
        log.debug({ err, dir }, "no du cache folder to sweep");
        return 0;
    }

    let removed = 0;
    for (const name of names) {
        const m = /\.tmp\.(\d+)$/.exec(name);
        if (!m || !duRunGone(Number(m[1]))) {
            continue;
        }

        try {
            unlinkSync(join(dir, name));
            removed++;
            log.info({ file: join(dir, name) }, "removed an orphan temp file of a dead du run");
        } catch (err) {
            log.warn({ err, file: join(dir, name) }, "could not remove an orphan temp file");
        }
    }

    return removed;
}

/** Snapshots younger than this are all kept, so two builds on one day can still be compared. */
const KEEP_ALL_WITHIN_MS = 24 * 3_600_000;

/**
 * Keeps every snapshot of the last 24 hours, plus the newest snapshot of each
 * of the last `keepDaily` days and of each of the last `keepWeekly` weeks.
 */
export function applySnapshotRetention(
    db: Database,
    opts: { keepDaily: number; keepWeekly: number; now?: number }
): number {
    const snaps = db
        .query<{ id: number; taken_at_ms: number }, []>(
            "SELECT id, taken_at_ms FROM snapshots ORDER BY taken_at_ms DESC"
        )
        .all();
    const now = opts.now ?? Date.now();
    const keep = new Set<number>(snaps.filter((s) => now - s.taken_at_ms < KEEP_ALL_WITHIN_MS).map((s) => s.id));
    const days = new Set<string>();
    const weeks = new Set<string>();
    for (const s of snaps) {
        const d = new Date(s.taken_at_ms);
        const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        const weekStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
        const week = `${weekStart.getFullYear()}-${weekStart.getMonth()}-${weekStart.getDate()}`;
        if (!days.has(day) && days.size < opts.keepDaily) {
            days.add(day);
            keep.add(s.id);
        }

        if (!weeks.has(week) && weeks.size < opts.keepWeekly) {
            weeks.add(week);
            keep.add(s.id);
        }
    }

    const drop = snaps.filter((s) => !keep.has(s.id)).map((s) => s.id);
    for (const id of drop) {
        db.run("DELETE FROM snapshot_dirs WHERE snapshot_id = ?", [id]);
        db.run("DELETE FROM snapshots WHERE id = ?", [id]);
    }

    return drop.length;
}

function flaggedPaths(nodes: WalkNode[], flag: number): string[] {
    const byId = new Map(nodes.map((n) => [n.i, n]));
    const pathOf = (n: WalkNode): string => {
        const parent = byId.get(n.p);
        return parent ? join(pathOf(parent), n.n) : n.n;
    };
    return nodes.filter((n) => (n.fl & flag) !== 0).map(pathOf);
}

/**
 * A full walk of `root` into the index. The walk runs before any write lock is
 * taken on the database; the rows then go in through ONE `BEGIN IMMEDIATE`
 * transaction, so a reader sees either the previous build or this one, and a
 * crash rolls back to the previous one.
 */
export async function buildIndex(opts: BuildOptions): Promise<BuildResult> {
    const now = opts.now ?? Date.now;
    const emit = opts.emit ?? (() => {});
    const startedAt = now();
    const root = canonicalDir(opts.root);
    const threads = opts.threads ?? defaultBuildThreads();
    const withPrivate = opts.private !== false;
    const minDirBytes = opts.minDirBytes ?? INDEX_DEFAULTS.minDirBytes;
    const bigFileFloor = opts.bigFileFloor ?? INDEX_DEFAULTS.bigFileFloor;
    const bigFileLimit = opts.bigFileLimit ?? INDEX_DEFAULTS.bigFileLimit;
    const snapshotFloor = opts.snapshotFloor ?? INDEX_DEFAULTS.snapshotFloor;
    // The C walk compares excludes with the canonical paths it builds, so `/tmp/x`,
    // `/private/tmp/x/` and a path through a symlink must all become the same string.
    const excludes = (opts.excludes ?? []).map((p) => canonicalPath(p).replace(/\/+$/, "") || "/");
    if (excludes.length > 256) {
        throw new IndexError("usage", `At most 256 --exclude paths (got ${excludes.length}).`);
    }

    assertDiskFree(opts.db, opts.minFreeBytes ?? defaultMinFreeBytes(dbBytes(opts.db)));

    // A short wait, not zero: a writer that is only acquiring or releasing the lock
    // holds its arbitration file for a moment, and a zero wait reads that as "locked".
    return withIndexLock(
        opts.db,
        async () => {
            const db = openIndexDbForWrite(opts.db);
            try {
                const knownRoot = getMeta(db, "root");
                if (knownRoot !== null && knownRoot !== root && !opts.reset) {
                    throw new IndexError(
                        "root_changed",
                        `${opts.db} indexes ${knownRoot}, not ${root}. Pass --reset to start over, or --db for a second index.`
                    );
                }

                const swept = sweepDeadScans(db, startedAt);
                const orphans = sweepOrphanTempFiles(toolDataDir("du", "cache"));
                const options = {
                    minDirBytes,
                    bigFileFloor,
                    bigFileLimit,
                    private: withPrivate,
                    excludes,
                    snapshotFloor,
                };
                const scanId = startScan(db, {
                    kind: "build",
                    root,
                    startedAt,
                    threads,
                    options: { ...options, includeCloud: opts.includeCloud === true },
                });
                log.debug({ root, db: opts.db, scanId, swept, orphans, threads }, "index build started");
                emit({
                    type: "start",
                    command: "build",
                    schema_version: SCHEMA_VERSION,
                    scan_id: scanId,
                    root,
                    db: opts.db,
                    threads,
                    private: withPrivate,
                    started_at_ms: startedAt,
                });

                let lastProgress = 0;
                const blockedPaths: string[] = [];
                let walk: WalkOutput;
                try {
                    walk = await runIndexWalk({
                        root,
                        threads,
                        minDirBytes,
                        bigFileFloor,
                        bigFileLimit,
                        private: withPrivate,
                        excludes,
                        includeCloud: opts.includeCloud === true,
                        stallSeconds: opts.stallSeconds,
                        env: opts.walkEnv,
                        signal: opts.signal,
                        onBlocked: (bl) => {
                            blockedPaths.push(bl.path);
                            emit({ type: "blocked", phase: "walk", path: bl.path, waited_ms: bl.waited_ms });
                        },
                        onProgress: (p) => {
                            const t = now();
                            if (t - lastProgress < PROGRESS_MIN_INTERVAL_MS) {
                                return;
                            }

                            lastProgress = t;
                            emit(progressEvent(p));
                        },
                    });
                } catch (err) {
                    const aborted = opts.signal?.aborted === true;
                    finishScan(db, scanId, aborted ? "aborted" : "failed", now());
                    if (aborted) {
                        throw new IndexError("aborted", "The build was cancelled; the previous index is unchanged.");
                    }

                    throw new IndexError("walk_failed", err instanceof Error ? err.message : String(err));
                }

                if (walk.end.root_errno !== 0 || walk.nodes.length === 0) {
                    finishScan(db, scanId, "failed", now());
                    throw new IndexError("walk_failed", `Cannot read ${root} (errno ${walk.end.root_errno}).`);
                }

                // Once the rows are in, a cancel no longer helps anyone: the commit is about a second.
                let reset: BuildResult["reset"] = opts.reset ? "requested" : null;
                const knownFsid = getMeta(db, "volume_fsid");
                const knownUuid = getMeta(db, "volume_uuid");
                const volumeUuid = volumeUuidAt(root);
                if (
                    !reset &&
                    !sameVolume({ fsid: knownFsid, uuid: knownUuid }, { fsid: walk.end.fsid || null, uuid: volumeUuid })
                ) {
                    reset = "volume_changed";
                    log.warn({ knownFsid, fsid: walk.end.fsid, root }, "volume changed; rebuilding from empty");
                }

                const ingestStart = now();
                emit({ type: "phase", phase: "ingest", rows: walk.nodes.length, elapsed_ms: ingestStart - startedAt });
                const rootNode = walk.nodes[0];
                let bigFiles = 0;
                let snapshotId: number | null = null;
                db.run("BEGIN IMMEDIATE");
                try {
                    if (reset) {
                        for (const table of ["dirs", "big_files", "snapshot_dirs", "snapshots"]) {
                            db.run(`DELETE FROM ${table}`);
                        }
                    }

                    const idMap = new Map<number, number>();
                    const upsert = prepareUpsert(db);
                    for (const node of walk.nodes) {
                        const parentId = node.p < 0 ? 0 : idMap.get(node.p);
                        if (parentId === undefined) {
                            throw new Error(`index row ${node.i} arrived before its parent ${node.p}`);
                        }

                        idMap.set(node.i, upsertNode(upsert, { parentId, node, name: node.n, scanId, withPrivate }));
                    }

                    db.run(
                        `UPDATE dirs SET flags = flags | ${DIR_FLAGS.gone} WHERE scan_id != ? AND (flags & ${DIR_FLAGS.gone}) = 0`,
                        [scanId]
                    );
                    db.run("DELETE FROM big_files");
                    bigFiles = insertBigFiles(db, walk.big, idMap, scanId);

                    if (opts.snapshot !== false) {
                        snapshotId = scanId;
                        db.run(
                            "INSERT INTO snapshots (id, taken_at_ms, root, alloc_bytes, files, floor_bytes) VALUES (?, ?, ?, ?, ?, ?)",
                            [scanId, now(), root, rootNode.a, rootNode.c, snapshotFloor]
                        );
                        db.run(
                            `INSERT INTO snapshot_dirs (snapshot_id, dir_id, alloc_bytes, logical_bytes, files)
                         SELECT ?, id, alloc_bytes, logical_bytes, files FROM dirs
                         WHERE (flags & ${DIR_FLAGS.gone}) = 0 AND alloc_bytes >= ?`,
                            [scanId, snapshotFloor]
                        );
                        applySnapshotRetention(db, {
                            keepDaily: INDEX_DEFAULTS.keepDaily,
                            keepWeekly: INDEX_DEFAULTS.keepWeekly,
                            now: now(),
                        });
                    }

                    gcTombstones(db);
                    const meta: Record<string, string> = {
                        root,
                        volume_fsid: walk.end.fsid,
                        ...(volumeUuid ? { volume_uuid: volumeUuid } : {}),
                        private: withPrivate ? "1" : "0",
                        min_dir_bytes: String(minDirBytes),
                        big_file_floor: String(bigFileFloor),
                        big_file_limit: String(bigFileLimit),
                        snapshot_floor: String(snapshotFloor),
                        excludes: SafeJSON.stringify(excludes),
                        include_cloud: opts.includeCloud === true ? "1" : "0",
                        last_build_scan_id: String(scanId),
                        tool_version: INDEX_DEFAULTS.toolVersion,
                    };
                    for (const [k, v] of Object.entries(meta)) {
                        setMeta(db, k, v);
                    }

                    setMeta(db, "blocked_dirs", String(countBlocked(db)));

                    // The walk saw every change queued before it started.
                    db.run("DELETE FROM dirty_queue WHERE queued_at_ms < ?", [startedAt]);
                    finishScan(db, scanId, "done", now(), {
                        files: walk.end.files,
                        dirs: walk.end.dirs,
                        alloc_bytes: rootNode.a,
                        logical_bytes: rootNode.l,
                        private_bytes: withPrivate ? rootNode.v : null,
                        denied_dirs: walk.end.denied,
                        vanished_dirs: walk.end.vanished,
                        read_errors: walk.end.errors,
                        walk_ms: walk.end.walk_ms,
                    });
                    db.run("UPDATE scans SET threads = ? WHERE id = ?", [walk.end.threads, scanId]);
                    db.run("COMMIT");
                } catch (err) {
                    db.run("ROLLBACK");
                    finishScan(db, scanId, "failed", now());
                    throw err;
                }

                const commitAt = now();
                emit({ type: "phase", phase: "commit", rows: walk.nodes.length, elapsed_ms: commitAt - startedAt });
                checkpoint(db);
                const doneAt = now();
                emit({ type: "phase", phase: "checkpoint", rows: null, elapsed_ms: doneAt - startedAt });

                const result: BuildResult = {
                    type: "result",
                    command: "build",
                    schema_version: SCHEMA_VERSION,
                    scan_id: scanId,
                    snapshot_id: snapshotId,
                    root,
                    db: opts.db,
                    threads: walk.end.threads,
                    private: withPrivate,
                    min_dir_bytes: minDirBytes,
                    big_file_floor: bigFileFloor,
                    files: walk.end.files,
                    dirs: walk.end.dirs,
                    stored_dirs: walk.nodes.length,
                    folded_dirs: walk.end.folded,
                    big_files: bigFiles,
                    alloc_bytes: rootNode.a,
                    logical_bytes: rootNode.l,
                    private_bytes: withPrivate ? rootNode.v : null,
                    denied_dirs: walk.end.denied,
                    vanished_dirs: walk.end.vanished,
                    read_errors: walk.end.errors,
                    skipped_cloud: flaggedPaths(walk.nodes, DIR_FLAGS.cloudSkipped),
                    skipped_mounts: flaggedPaths(walk.nodes, DIR_FLAGS.mountSkipped),
                    blocked_dirs: walk.end.blocked,
                    blocked_paths: blockedPaths,
                    reset,
                    walk_ms: walk.end.walk_ms,
                    ingest_ms: commitAt - ingestStart,
                    elapsed_ms: doneAt - startedAt,
                    db_bytes: dbBytes(opts.db),
                };
                log.debug({ ...result, skipped_cloud: undefined, skipped_mounts: undefined }, "index build done");
                return result;
            } finally {
                db.close();
            }
        },
        opts.lockWaitMs ?? 1000
    );
}

/** Folds the WAL back into the database; PASSIVE when a reader holds it open. */
export function checkpoint(db: Database): void {
    const res = db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (res && res.busy !== 0) {
        db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
        log.debug("wal checkpoint TRUNCATE was busy; ran PASSIVE");
    }
}
