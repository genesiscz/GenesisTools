import type { Database, Statement } from "bun:sqlite";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { lockHolderPid, lockPathFor } from "./db";
import { DIR_FLAGS } from "./schema";
import type { AsOf, DirRow, NodeOut } from "./types";
import { IndexError } from "./types";
import type { WalkBig, WalkNode } from "./walk";

const log = logger.child({ component: "du:index:store" });

/** Runs `fn` holding the index write lock. `waitMs` 0 fails at once with `locked`. */
export async function withIndexLock<T>(dbPath: string, fn: () => Promise<T>, waitMs = 0): Promise<T> {
    const lockPath = lockPathFor(dbPath);
    try {
        return await withFileLock(lockPath, fn, waitMs);
    } catch (err) {
        if (err instanceof LockTimeoutError) {
            const pid = lockHolderPid(lockPath);
            throw new IndexError(
                "locked",
                `Another index build or update holds ${lockPath}${pid ? ` (pid ${pid})` : ""}. Try again when it finishes.`
            );
        }

        throw err;
    }
}

/** The real path of an existing directory, so `/tmp` and `/private/tmp` index as one tree. */
export function canonicalDir(path: string): string {
    const abs = resolve(path);
    let real: string;
    try {
        real = realpathSync(abs);
    } catch (err) {
        throw new IndexError(
            "usage",
            `Not a directory: ${abs} (${(err as NodeJS.ErrnoException).code ?? "unreadable"})`
        );
    }

    if (!statSync(real).isDirectory()) {
        throw new IndexError("usage", `Not a directory: ${abs}`);
    }

    return real;
}

/** Absolute and symlink-free for the part that exists; a missing tail is kept as written. */
export function canonicalPath(path: string): string {
    let head = isAbsolute(path) ? path : resolve(path);
    const tail: string[] = [];
    while (!existsSync(head) && dirname(head) !== head) {
        tail.unshift(basename(head));
        head = dirname(head);
    }

    let real = head;
    try {
        real = realpathSync(head);
    } catch (err) {
        log.debug({ err, head }, "realpath failed; keeping the path as written");
    }

    return tail.length > 0 ? join(real, ...tail) : real;
}

/** True when `path` is `root` or inside it. */
export function isUnder(root: string, path: string): boolean {
    if (path === root) {
        return true;
    }

    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix);
}

export function startScan(
    db: Database,
    opts: { kind: "build" | "update"; root: string; startedAt: number; threads: number; options: unknown }
): number {
    const res = db.run(
        "INSERT INTO scans (kind, root, started_at_ms, status, threads, pid, options_json) VALUES (?, ?, ?, 'running', ?, ?, ?)",
        [opts.kind, opts.root, opts.startedAt, opts.threads, process.pid, SafeJSON.stringify(opts.options)]
    );
    return Number(res.lastInsertRowid);
}

export interface ScanTotals {
    files: number;
    dirs: number;
    alloc_bytes: number;
    logical_bytes: number;
    private_bytes: number | null;
    denied_dirs: number;
    vanished_dirs: number;
    read_errors: number;
    walk_ms: number;
}

export function finishScan(
    db: Database,
    id: number,
    status: "done" | "failed" | "aborted",
    finishedAt: number,
    totals?: ScanTotals
): void {
    if (!totals) {
        db.run("UPDATE scans SET status = ?, finished_at_ms = ? WHERE id = ?", [status, finishedAt, id]);
        return;
    }

    db.run(
        `UPDATE scans SET status = ?, finished_at_ms = ?, files = ?, dirs = ?, alloc_bytes = ?, logical_bytes = ?,
         private_bytes = ?, denied_dirs = ?, vanished_dirs = ?, read_errors = ?, walk_ms = ? WHERE id = ?`,
        [
            status,
            finishedAt,
            totals.files,
            totals.dirs,
            totals.alloc_bytes,
            totals.logical_bytes,
            totals.private_bytes,
            totals.denied_dirs,
            totals.vanished_dirs,
            totals.read_errors,
            totals.walk_ms,
            id,
        ]
    );
}

/**
 * Inserts or refreshes one directory row, keyed by (parent_id, name) so an
 * unchanged directory keeps its id across builds (snapshots refer to ids).
 * A revived tombstone counts as new for `first_scan_id`.
 */
export function prepareUpsert(db: Database): Statement<{ id: number }> {
    return db.prepare<{ id: number }, (string | number | null)[]>(
        `INSERT INTO dirs (parent_id, name, fileid, alloc_bytes, logical_bytes, private_bytes, files, dirs,
                           max_file_bytes, newest_mtime_s, dir_mtime_ms, flags, scan_id, first_scan_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
         ON CONFLICT(parent_id, name) DO UPDATE SET
           fileid = excluded.fileid, alloc_bytes = excluded.alloc_bytes, logical_bytes = excluded.logical_bytes,
           private_bytes = excluded.private_bytes, files = excluded.files, dirs = excluded.dirs,
           max_file_bytes = excluded.max_file_bytes, newest_mtime_s = excluded.newest_mtime_s,
           dir_mtime_ms = excluded.dir_mtime_ms,
           first_scan_id = CASE WHEN (dirs.flags & ${DIR_FLAGS.gone}) != 0 THEN excluded.first_scan_id ELSE dirs.first_scan_id END,
           flags = excluded.flags, scan_id = excluded.scan_id
         RETURNING id`
    );
}

export function upsertNode(
    stmt: Statement<{ id: number }>,
    opts: { parentId: number; node: WalkNode; name: string; scanId: number; withPrivate: boolean }
): number {
    const n = opts.node;
    const row = stmt.get(
        opts.parentId,
        opts.name,
        n.f,
        n.a,
        n.l,
        opts.withPrivate ? n.v : null,
        n.c,
        n.d,
        n.x,
        n.m,
        n.dm,
        n.fl,
        opts.scanId
    );
    if (!row) {
        throw new Error(`upsert of ${opts.name} returned no id`);
    }

    return row.id;
}

export function insertBigFiles(db: Database, rows: WalkBig[], idMap: Map<number, number>, scanId: number): number {
    const stmt = db.prepare(
        `INSERT OR REPLACE INTO big_files (path, dir_id, logical_bytes, alloc_bytes, fileid, mtime_ms, nlink, scan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let n = 0;
    for (const b of rows) {
        const dirId = idMap.get(b.o);
        if (dirId === undefined) {
            log.warn({ path: b.p, owner: b.o }, "big file owner has no row; skipped");
            continue;
        }

        stmt.run(b.p, dirId, b.l, b.a, b.f, b.m, b.n, scanId);
        n++;
    }

    return n;
}

/**
 * Deletes tombstones no retained snapshot needs. A referenced tombstone keeps its
 * ancestors too, so `diff` can still print its path from the parent chain.
 */
export function gcTombstones(db: Database): number {
    const res = db.run(
        `WITH RECURSIVE keep(id) AS (
           SELECT DISTINCT dir_id FROM snapshot_dirs
           UNION
           SELECT d.parent_id FROM dirs d JOIN keep k ON d.id = k.id WHERE d.parent_id != 0
         )
         DELETE FROM dirs WHERE (flags & ${DIR_FLAGS.gone}) != 0 AND id NOT IN (SELECT id FROM keep)`
    );
    return res.changes;
}

/** Live rows the stall watchdog gave up (flag 32). */
export function countBlocked(db: Database): number {
    return (
        db
            .query<{ n: number }, []>(
                `SELECT COUNT(*) AS n FROM dirs WHERE (flags & ${DIR_FLAGS.blocked}) != 0 AND (flags & ${DIR_FLAGS.gone}) = 0`
            )
            .get()?.n ?? 0
    );
}

/**
 * The index invariant, checked on the rows an update wrote and their ancestors:
 * no total is negative, a folder covers the sum of its live stored children (the
 * rest is its own files plus folded subfolders), and no live row hangs under a
 * gone one. A violation throws `inconsistent`, so the caller rolls back rather
 * than store totals a build would never produce.
 */
export function assertConsistent(db: Database, ids: number[]): void {
    if (ids.length === 0) {
        return;
    }

    const bad = db
        .query<
            {
                id: number;
                alloc_bytes: number;
                ca: number;
                files: number;
                cf: number;
                dirs: number;
                cd: number;
                logical_bytes: number;
                cl: number;
                parent_gone: number;
                gone: number;
            },
            [string]
        >(
            `SELECT d.id, d.alloc_bytes, d.files, d.dirs, d.logical_bytes,
                    (d.flags & ${DIR_FLAGS.gone}) AS gone,
                    COALESCE((SELECT p.flags & ${DIR_FLAGS.gone} FROM dirs p WHERE p.id = d.parent_id), 0) AS parent_gone,
                    COALESCE(SUM(c.alloc_bytes), 0) AS ca, COALESCE(SUM(c.logical_bytes), 0) AS cl,
                    COALESCE(SUM(c.files), 0) AS cf, COALESCE(SUM(c.dirs), 0) + COUNT(c.id) AS cd
             FROM dirs d LEFT JOIN dirs c ON c.parent_id = d.id AND (c.flags & ${DIR_FLAGS.gone}) = 0
             WHERE d.id IN (SELECT DISTINCT value FROM json_each(?))
             GROUP BY d.id`
        )
        .all(SafeJSON.stringify(ids))
        .filter(
            (r) =>
                r.gone === 0 &&
                (r.parent_gone !== 0 ||
                    r.alloc_bytes < 0 ||
                    r.alloc_bytes < r.ca ||
                    r.logical_bytes < r.cl ||
                    r.files < r.cf ||
                    r.dirs < r.cd)
        );
    if (bad.length > 0) {
        const pathOf = makePathOf(db);
        const first = bad[0];
        throw new IndexError(
            "inconsistent",
            `The update would leave ${bad.length} folder(s) inconsistent (first: ${pathOf(first.id)}, ` +
                `${first.alloc_bytes} bytes against ${first.ca} in its stored children). Nothing was written; run \`${toolCommand("du index build")}\`.`
        );
    }
}

export function getRow(db: Database, id: number): DirRow | null {
    return db.query<DirRow, [number]>("SELECT * FROM dirs WHERE id = ?").get(id);
}

export function rootRow(db: Database): DirRow | null {
    return db
        .query<DirRow, []>(`SELECT * FROM dirs WHERE parent_id = 0 AND (flags & ${DIR_FLAGS.gone}) = 0 LIMIT 1`)
        .get();
}

export function liveChildren(db: Database, id: number): DirRow[] {
    return db
        .query<DirRow, [number]>(`SELECT * FROM dirs WHERE parent_id = ? AND (flags & ${DIR_FLAGS.gone}) = 0`)
        .all(id);
}

/** Absolute path of a row, from its parent chain (tombstones included). Memoised per call site. */
export function makePathOf(db: Database): (id: number) => string {
    const cache = new Map<number, string>();
    const stmt = db.query<{ parent_id: number; name: string }, [number]>(
        "SELECT parent_id, name FROM dirs WHERE id = ?"
    );
    const pathOf = (id: number): string => {
        const hit = cache.get(id);
        if (hit !== undefined) {
            return hit;
        }

        const row = stmt.get(id);
        if (!row) {
            throw new Error(`dirs row ${id} is missing from the parent chain`);
        }

        const path = row.parent_id === 0 ? row.name : join(pathOf(row.parent_id), row.name);
        cache.set(id, path);
        return path;
    };
    return pathOf;
}

export interface StoredLookup {
    /** The deepest live stored row on the way to `path`. */
    row: DirRow;
    rowPath: string;
    /** True when `path` itself is a stored row. */
    exact: boolean;
}

/** Walks `path` component by component from the root row. Null when `path` is outside the root. */
export function findStored(db: Database, root: DirRow, path: string): StoredLookup | null {
    if (!isUnder(root.name, path)) {
        return null;
    }

    const rest =
        path === root.name
            ? []
            : path
                  .slice(root.name.length)
                  .split("/")
                  .filter((s) => s.length > 0);
    const stmt = db.query<DirRow, [number, string]>(
        `SELECT * FROM dirs WHERE parent_id = ? AND name = ? AND (flags & ${DIR_FLAGS.gone}) = 0`
    );
    let row = root;
    let rowPath = root.name;
    let matched = 0;
    for (const part of rest) {
        const child = stmt.get(row.id, part);
        if (!child) {
            break;
        }

        row = child;
        rowPath = join(rowPath, part);
        matched++;
    }

    return { row, rowPath, exact: matched === rest.length };
}

export function nodeOut(row: DirRow, path: string, storedChildren: number): NodeOut {
    return {
        id: row.id,
        parent_id: row.parent_id,
        name: row.name,
        path,
        alloc_bytes: row.alloc_bytes,
        logical_bytes: row.logical_bytes,
        private_bytes: row.private_bytes,
        files: row.files,
        dirs: row.dirs,
        max_file_bytes: row.max_file_bytes,
        newest_mtime_s: row.newest_mtime_s,
        dir_mtime_ms: row.dir_mtime_ms,
        flags: row.flags,
        scan_id: row.scan_id,
        stored_children: storedChildren,
    };
}

/** What the answer is measured from: the newest finished scan, and the last full build. */
export function readAsOf(db: Database, now: number): AsOf | null {
    const last = db
        .query<{ id: number; kind: "build" | "update"; status: string; finished_at_ms: number | null }, []>(
            "SELECT id, kind, status, finished_at_ms FROM scans WHERE status = 'done' ORDER BY id DESC LIMIT 1"
        )
        .get();
    if (!last) {
        return null;
    }

    const build = db
        .query<{ id: number; finished_at_ms: number | null }, []>(
            "SELECT id, finished_at_ms FROM scans WHERE status = 'done' AND kind = 'build' ORDER BY id DESC LIMIT 1"
        )
        .get();
    return {
        scan_id: last.id,
        kind: last.kind,
        status: last.status,
        finished_at_ms: last.finished_at_ms,
        age_s: last.finished_at_ms === null ? null : Math.max(0, Math.round((now - last.finished_at_ms) / 1000)),
        last_build_scan_id: build?.id ?? null,
        last_build_at_ms: build?.finished_at_ms ?? null,
    };
}

/** The root of a built index, or `not_built`. */
export function requireBuilt(db: Database, dbPath: string): DirRow {
    const root = rootRow(db);
    if (!root) {
        throw new IndexError(
            "not_built",
            `${dbPath} has no finished build. Run \`${toolCommand("du index build")}\` first.`
        );
    }

    return root;
}
