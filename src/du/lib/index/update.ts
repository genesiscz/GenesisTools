import type { Database } from "bun:sqlite";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { assertDiskFree, defaultMinFreeBytes, INDEX_DEFAULTS } from "./build";
import { dbBytes, getMeta, openIndexDbForWrite, setMeta, sweepDeadScans } from "./db";
import { DIR_FLAGS, SCHEMA_VERSION } from "./schema";
import {
    assertConsistent,
    canonicalDir,
    canonicalPath,
    countBlocked,
    findStored,
    finishScan,
    gcTombstones,
    getRow,
    insertBigFiles,
    isUnder,
    liveChildren,
    prepareUpsert,
    requireBuilt,
    rootRow,
    startScan,
    upsertNode,
    withIndexLock,
} from "./store";
import type { DirRow, IndexEvent, RegionResult, UpdateResult } from "./types";
import { IndexError } from "./types";
import { runIndexWalk, type WalkOutput } from "./walk";

const log = logger.child({ component: "du:index:update" });

const ENOENT = 2;
const ENOTDIR = 20;

export interface UpdateOptions {
    db: string;
    /** Must match the indexed root when given. */
    root?: string;
    paths: string[];
    /** The paths are files (or entries): recheck their parent directory's region. */
    shallow?: boolean;
    /** Re-walk the whole subtree of each path, stored descendants included. */
    recursive?: boolean;
    /** Also consume the paths queued in `dirty_queue`. */
    fromQueue?: boolean;
    threads?: number;
    /** Give up a folder whose listing makes no progress for this many seconds (default 10). */
    stallSeconds?: number;
    /** How long to wait for a running build or update before queueing the paths instead. */
    lockWaitMs?: number;
    minFreeBytes?: number;
    signal?: AbortSignal;
    emit?: (event: IndexEvent) => void;
    now?: () => number;
}

interface Target {
    path: string;
    shallow: boolean;
    recursive: boolean;
}

interface Owner {
    row: DirRow;
    path: string;
    recursive: boolean;
}

function excludedBy(excludes: string[], path: string): boolean {
    return excludes.some((ex) => isUnder(ex, path));
}

/** The stored directory whose region holds `target`: itself when it is stored and still the same directory. */
function resolveOwner(db: Database, root: DirRow, target: string): { row: DirRow; path: string } | null {
    const found = findStored(db, root, target);
    if (!found) {
        return null;
    }

    if (!found.exact || found.row.parent_id === 0) {
        return { row: found.row, path: found.rowPath };
    }

    let same = false;
    try {
        const st = lstatSync(target);
        same = st.isDirectory() && st.ino === found.row.fileid;
    } catch (err) {
        log.debug({ err, target }, "stored directory is gone");
    }

    if (same) {
        return { row: found.row, path: found.rowPath };
    }

    // Gone or replaced: the parent's region walk drops (or re-adds) it.
    const parent = getRow(db, found.row.parent_id);
    if (!parent) {
        throw new Error(`dirs row ${found.row.id} has no parent row ${found.row.parent_id}`);
    }

    return { row: parent, path: dirname(found.rowPath) };
}

function writeKeepFile(dir: string, n: number, owner: Owner, children: DirRow[]): string {
    const file = join(dir, `keep-${n}.tsv`);
    const lines = owner.recursive ? [] : children.map((c) => `${c.fileid}\t${join(owner.path, c.name)}`);
    writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    return file;
}

interface RegionApply {
    region: RegionResult;
    promoted: number;
    removed: number;
    /** The owner, its ancestors and every row it wrote: what the consistency check reads. */
    touched: number[];
}

/**
 * A recursive region walks its whole subtree, so a region inside it would count
 * the same bytes twice (the 2026-10-13 review drove a root to -1,273,856 bytes
 * with `--recursive --paths a a/b/c`). Duplicates already collapse by row id.
 */
function normalizeOwners(owners: Owner[]): Owner[] {
    const recursive = owners.filter((o) => o.recursive);
    return owners.filter((o) => !recursive.some((r) => r.row.id !== o.row.id && isUnder(r.path, o.path)));
}

/**
 * Applies one region walk: refreshes or promotes the walked directories, drops
 * the stored ones that are gone, sets the owner's totals from its walked part
 * plus its kept children, and pushes the difference up to the root.
 */
function applyRegion(
    db: Database,
    opts: { owner: Owner; walk: WalkOutput; scanId: number; withPrivate: boolean }
): RegionApply | null {
    const { owner, walk, scanId, withPrivate } = opts;
    const old = getRow(db, owner.row.id);
    const r = walk.region;
    if (!old || !r) {
        throw new Error(`region ${owner.path} has no ${old ? "region row" : "stored row"}`);
    }

    // Another region of this update already dropped it; applying would revive it.
    if ((old.flags & DIR_FLAGS.gone) !== 0) {
        return null;
    }

    const keptJson = SafeJSON.stringify(walk.kept);
    const idMap = new Map<number, number>([[0, old.id]]);
    const upsert = prepareUpsert(db);
    const existing = db.query<{ flags: number }, [number, string]>(
        "SELECT flags FROM dirs WHERE parent_id = ? AND name = ?"
    );
    let promoted = 0;
    for (const node of walk.nodes) {
        const parentId = idMap.get(node.p);
        if (parentId === undefined) {
            throw new Error(`region row ${node.i} arrived before its parent ${node.p}`);
        }

        const prev = existing.get(parentId, node.n);
        if (!prev || (prev.flags & DIR_FLAGS.gone) !== 0) {
            promoted++;
        }

        idMap.set(node.i, upsertNode(upsert, { parentId, node, name: node.n, scanId, withPrivate }));
    }

    // Every live row below a child that was walked again (not kept): the refreshed
    // ones carry this scan's id, the rest are gone or folded now.
    const regionIds = db
        .query<{ id: number }, [number, string]>(
            `WITH RECURSIVE sub(id) AS (
               SELECT id FROM dirs WHERE parent_id = ?1 AND (flags & ${DIR_FLAGS.gone}) = 0
                 AND name NOT IN (SELECT value FROM json_each(?2))
               UNION ALL
               SELECT d.id FROM dirs d JOIN sub s ON d.parent_id = s.id WHERE (d.flags & ${DIR_FLAGS.gone}) = 0
             )
             SELECT id FROM sub`
        )
        .all(old.id, keptJson)
        .map((row) => row.id);
    const regionJson = SafeJSON.stringify([old.id, ...regionIds]);
    db.run("DELETE FROM big_files WHERE dir_id IN (SELECT value FROM json_each(?))", [regionJson]);
    insertBigFiles(db, walk.big, idMap, scanId);
    const removed = db.run(
        `UPDATE dirs SET flags = flags | ${DIR_FLAGS.gone}
         WHERE id IN (SELECT value FROM json_each(?)) AND scan_id != ? AND (flags & ${DIR_FLAGS.gone}) = 0`,
        [SafeJSON.stringify(regionIds), scanId]
    ).changes;

    const kept = db
        .query<DirRow, [number, string]>(
            `SELECT * FROM dirs WHERE parent_id = ? AND (flags & ${DIR_FLAGS.gone}) = 0
               AND name IN (SELECT value FROM json_each(?))`
        )
        .all(old.id, keptJson);
    const next = {
        alloc_bytes: r.a,
        logical_bytes: r.l,
        private_bytes: withPrivate ? r.v : null,
        files: r.c,
        dirs: r.d,
        max_file_bytes: r.x,
        newest_mtime_s: r.m,
    };
    for (const k of kept) {
        next.alloc_bytes += k.alloc_bytes;
        next.logical_bytes += k.logical_bytes;
        if (next.private_bytes !== null) {
            next.private_bytes += k.private_bytes ?? 0;
        }

        next.files += k.files;
        next.dirs += k.dirs + 1;
        next.max_file_bytes = Math.max(next.max_file_bytes, k.max_file_bytes);
        next.newest_mtime_s = Math.max(next.newest_mtime_s, k.newest_mtime_s);
    }

    db.run(
        `UPDATE dirs SET fileid = ?, dir_mtime_ms = ?, flags = ?, alloc_bytes = ?, logical_bytes = ?, private_bytes = ?,
           files = ?, dirs = ?, max_file_bytes = ?, newest_mtime_s = ?, scan_id = ? WHERE id = ?`,
        [
            r.f,
            r.dm,
            r.fl,
            next.alloc_bytes,
            next.logical_bytes,
            next.private_bytes,
            next.files,
            next.dirs,
            next.max_file_bytes,
            next.newest_mtime_s,
            scanId,
            old.id,
        ]
    );

    const delta = {
        alloc_bytes: next.alloc_bytes - old.alloc_bytes,
        logical_bytes: next.logical_bytes - old.logical_bytes,
        private_bytes:
            next.private_bytes === null || old.private_bytes === null ? null : next.private_bytes - old.private_bytes,
        files: next.files - old.files,
        dirs: next.dirs - old.dirs,
    };
    // Sums move by the exact delta. The two maxima only grow until the next build
    // recomputes them, which is safe for a "changed within" prefilter.
    const bump = db.prepare<{ parent_id: number }, number[]>(
        `UPDATE dirs SET alloc_bytes = alloc_bytes + ?, logical_bytes = logical_bytes + ?,
           private_bytes = private_bytes + ?, files = files + ?, dirs = dirs + ?,
           max_file_bytes = MAX(max_file_bytes, ?), newest_mtime_s = MAX(newest_mtime_s, ?)
         WHERE id = ? RETURNING parent_id`
    );
    const touched = [old.id, ...idMap.values()];
    let parentId = old.parent_id;
    while (parentId !== 0) {
        touched.push(parentId);
        const row = bump.get(
            delta.alloc_bytes,
            delta.logical_bytes,
            delta.private_bytes ?? 0,
            delta.files,
            delta.dirs,
            next.max_file_bytes,
            next.newest_mtime_s,
            parentId
        );
        if (!row) {
            throw new Error(`ancestor row ${parentId} of ${owner.path} is missing`);
        }

        parentId = row.parent_id;
    }

    return {
        region: {
            owner: owner.path,
            owner_id: old.id,
            files: walk.end.files,
            dirs: walk.end.dirs,
            kept: walk.kept.length,
            walk_ms: walk.end.walk_ms,
            delta,
        },
        promoted,
        removed,
        touched,
    };
}

function queuePaths(dbPath: string, targets: Target[], now: number): { root: string; queued: number } {
    const db = openIndexDbForWrite(dbPath);
    try {
        const stmt = db.prepare(
            `INSERT INTO dirty_queue (path, shallow, recursive, queued_at_ms) VALUES (?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET shallow = MIN(shallow, excluded.shallow),
             recursive = MAX(recursive, excluded.recursive), queued_at_ms = excluded.queued_at_ms`
        );
        for (const t of targets) {
            stmt.run(t.path, t.shallow ? 1 : 0, t.recursive ? 1 : 0, now);
        }

        return { root: getMeta(db, "root") ?? "", queued: targets.length };
    } finally {
        db.close();
    }
}

/**
 * Re-walks only the regions that hold the given paths and re-aggregates up to
 * the root. When another build or update holds the lock past `lockWaitMs`, the
 * paths go to `dirty_queue` instead and the result says `deferred`.
 */
export async function updateIndex(opts: UpdateOptions): Promise<UpdateResult> {
    const now = opts.now ?? Date.now;
    const startedAt = now();
    const targets: Target[] = opts.paths.map((p) => ({
        path: canonicalPath(p),
        shallow: opts.shallow === true,
        recursive: opts.recursive === true,
    }));
    assertDiskFree(opts.db, opts.minFreeBytes ?? defaultMinFreeBytes(dbBytes(opts.db)));

    try {
        return await withIndexLock(opts.db, () => runUpdate(opts, targets, startedAt), opts.lockWaitMs ?? 2000);
    } catch (err) {
        if (!(err instanceof IndexError) || err.code !== "locked") {
            throw err;
        }

        const { root, queued } = queuePaths(opts.db, targets, now());
        log.debug({ queued, db: opts.db }, "index is locked; paths queued");
        return {
            type: "result",
            command: "update",
            schema_version: SCHEMA_VERSION,
            scan_id: null,
            root,
            deferred: true,
            queued,
            regions: [],
            promoted: 0,
            removed: 0,
            ignored: [],
            elapsed_ms: now() - startedAt,
        };
    }
}

async function runUpdate(opts: UpdateOptions, targets: Target[], startedAt: number): Promise<UpdateResult> {
    const now = opts.now ?? Date.now;
    const emit = opts.emit ?? (() => {});
    const db = openIndexDbForWrite(opts.db);
    let workDir: string | null = null;
    try {
        const root = requireBuilt(db, opts.db);
        if (opts.root !== undefined && canonicalDir(opts.root) !== root.name) {
            throw new IndexError("root_changed", `${opts.db} indexes ${root.name}, not ${canonicalDir(opts.root)}.`);
        }

        const withPrivate = getMeta(db, "private") !== "0";
        const excludes = SafeJSON.parse(getMeta(db, "excludes") ?? "[]", { strict: true }) as string[];
        const includeCloud = getMeta(db, "include_cloud") === "1";
        const minDirBytes = Number(getMeta(db, "min_dir_bytes") ?? INDEX_DEFAULTS.minDirBytes);
        const bigFileFloor = Number(getMeta(db, "big_file_floor") ?? INDEX_DEFAULTS.bigFileFloor);
        const fsid = getMeta(db, "volume_fsid");

        const queueReadAt = now();
        const queued = opts.fromQueue
            ? db
                  .query<{ path: string; shallow: number; recursive: number }, []>(
                      "SELECT path, shallow, recursive FROM dirty_queue ORDER BY path"
                  )
                  .all()
            : [];
        const all: Target[] = [
            ...targets,
            ...queued.map((q) => ({
                path: q.path,
                shallow: q.shallow === 1,
                recursive: q.recursive === 1 || opts.recursive === true,
            })),
        ];

        const ignored: string[] = [];
        const owners = new Map<number, Owner>();
        for (const t of all) {
            const target = t.shallow && t.path !== root.name ? dirname(t.path) : t.path;
            if (!isUnder(root.name, target) || excludedBy(excludes, target)) {
                ignored.push(t.path);
                continue;
            }

            const owner = resolveOwner(db, root, target);
            if (!owner) {
                ignored.push(t.path);
                continue;
            }

            const prev = owners.get(owner.row.id);
            owners.set(owner.row.id, { ...owner, recursive: t.recursive || prev?.recursive === true });
        }

        const regionOwners = normalizeOwners([...owners.values()]);
        sweepDeadScans(db, startedAt);
        const threads = opts.threads ?? 4;
        const scanId = startScan(db, {
            kind: "update",
            root: root.name,
            startedAt,
            threads,
            options: {
                paths: all.map((t) => t.path),
                shallow: opts.shallow === true,
                recursive: opts.recursive === true,
            },
        });
        emit({
            type: "start",
            command: "update",
            schema_version: SCHEMA_VERSION,
            scan_id: scanId,
            root: root.name,
            db: opts.db,
            threads,
            private: withPrivate,
            started_at_ms: startedAt,
        });

        // Walk every region first (no database lock held), then apply them in one transaction.
        workDir = mkdtempSync(join(tmpdir(), "du-index-update-"));
        const walks: { owner: Owner; walk: WalkOutput }[] = [];
        const pending = [...regionOwners];
        const walked = new Set<number>();
        let n = 0;
        try {
            for (let i = 0; i < pending.length; i++) {
                const owner = pending[i];
                if (walked.has(owner.row.id)) {
                    continue;
                }

                walked.add(owner.row.id);
                const keepFile = writeKeepFile(workDir, n++, owner, liveChildren(db, owner.row.id));
                const walk = await runIndexWalk({
                    root: owner.path,
                    threads,
                    minDirBytes,
                    bigFileFloor,
                    bigFileLimit: INDEX_DEFAULTS.bigFileLimit,
                    private: withPrivate,
                    excludes,
                    includeCloud,
                    keepFile,
                    stallSeconds: opts.stallSeconds,
                    signal: opts.signal,
                });
                const rootErr = walk.end.root_errno;
                if (rootErr === ENOENT || rootErr === ENOTDIR) {
                    // Deleted between the lookup and the walk: its parent's region drops it.
                    const parent = owner.row.parent_id === 0 ? null : getRow(db, owner.row.parent_id);
                    if (!parent) {
                        throw new IndexError("walk_failed", `The indexed root ${owner.path} is gone; run a build.`);
                    }

                    walked.delete(owner.row.id);
                    pending.push({ row: parent, path: dirname(owner.path), recursive: false });
                    continue;
                }

                if (rootErr !== 0) {
                    throw new IndexError("walk_failed", `Cannot read ${owner.path} (errno ${rootErr}).`);
                }

                if (fsid !== null && walk.end.fsid !== "" && walk.end.fsid !== fsid) {
                    throw new IndexError(
                        "volume_changed",
                        `${owner.path} is on another volume than the index (${walk.end.fsid}, built on ${fsid}). Run a build.`
                    );
                }

                walks.push({ owner, walk });
            }
        } catch (err) {
            const aborted = opts.signal?.aborted === true;
            finishScan(db, scanId, aborted ? "aborted" : "failed", now());
            if (aborted) {
                throw new IndexError("aborted", "The update was cancelled; the index is unchanged.");
            }

            if (err instanceof IndexError) {
                throw err;
            }

            throw new IndexError("walk_failed", err instanceof Error ? err.message : String(err));
        }

        const regions: RegionResult[] = [];
        let promoted = 0;
        let removed = 0;
        db.run("BEGIN IMMEDIATE");
        try {
            // Order does not matter: an apply reads the rows it sums, and an owner
            // that is a kept child of another one moves its ancestors by its delta.
            const touched: number[] = [];
            for (const w of walks) {
                const applied = applyRegion(db, { owner: w.owner, walk: w.walk, scanId, withPrivate });
                if (!applied) {
                    continue;
                }

                regions.push(applied.region);
                promoted += applied.promoted;
                removed += applied.removed;
                touched.push(...applied.touched);
            }

            gcTombstones(db);
            // Throws `inconsistent`, which rolls the whole update back.
            assertConsistent(db, touched);
            setMeta(db, "last_update_scan_id", String(scanId));
            setMeta(db, "blocked_dirs", String(countBlocked(db)));
            if (queued.length > 0) {
                db.run("DELETE FROM dirty_queue WHERE path IN (SELECT value FROM json_each(?)) AND queued_at_ms <= ?", [
                    SafeJSON.stringify(queued.map((q) => q.path)),
                    queueReadAt,
                ]);
            }

            const after = rootRow(db);
            finishScan(db, scanId, "done", now(), {
                files: walks.reduce((s, w) => s + w.walk.end.files, 0),
                dirs: walks.reduce((s, w) => s + w.walk.end.dirs, 0),
                alloc_bytes: after?.alloc_bytes ?? 0,
                logical_bytes: after?.logical_bytes ?? 0,
                private_bytes: after?.private_bytes ?? null,
                denied_dirs: walks.reduce((s, w) => s + w.walk.end.denied, 0),
                vanished_dirs: walks.reduce((s, w) => s + w.walk.end.vanished, 0),
                read_errors: walks.reduce((s, w) => s + w.walk.end.errors, 0),
                walk_ms: walks.reduce((s, w) => s + w.walk.end.walk_ms, 0),
            });
            db.run("COMMIT");
        } catch (err) {
            db.run("ROLLBACK");
            finishScan(db, scanId, "failed", now());
            throw err;
        }

        const result: UpdateResult = {
            type: "result",
            command: "update",
            schema_version: SCHEMA_VERSION,
            scan_id: scanId,
            root: root.name,
            deferred: false,
            queued: 0,
            regions,
            promoted,
            removed,
            ignored,
            elapsed_ms: now() - startedAt,
        };
        log.debug({ scanId, regions: regions.length, promoted, removed, ignored: ignored.length }, "index update done");
        return result;
    } finally {
        if (workDir) {
            rmSync(workDir, { recursive: true, force: true });
        }

        db.close();
    }
}
