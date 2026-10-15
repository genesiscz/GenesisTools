import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import { allMeta, dbBytes, getMeta, openIndexDbForRead } from "./db";
import { DIR_FLAGS, SCHEMA_VERSION } from "./schema";
import { canonicalPath, findStored, isUnder, makePathOf, nodeOut, readAsOf, requireBuilt } from "./store";
import type {
    AsOf,
    ChildOut,
    DirRow,
    LargestDirRow,
    LocalOut,
    QueryFound,
    QueryInfo,
    QueryLargest,
    QueryNotFound,
    ScanInfo,
    TopFile,
} from "./types";

export const QUERY_SORTS = ["alloc", "logical", "private", "files", "mtime", "name"] as const;
export type QuerySort = (typeof QUERY_SORTS)[number];

const ORDER_BY: Record<QuerySort, string> = {
    alloc: "alloc_bytes DESC, name",
    logical: "logical_bytes DESC, name",
    private: "private_bytes DESC, name",
    files: "files DESC, name",
    mtime: "newest_mtime_s DESC, name",
    name: "name",
};

const GONE = DIR_FLAGS.gone;
const ATTENTION_FLAGS =
    DIR_FLAGS.denied | DIR_FLAGS.incomplete | DIR_FLAGS.cloudSkipped | DIR_FLAGS.mountSkipped | DIR_FLAGS.blocked;

/** Blocked rows (flag 32) at or under `dir`. Free when the last walk blocked nothing (meta says 0). */
function blockedBelow(db: Database, dir: string): number {
    if (Number(getMeta(db, "blocked_dirs") ?? "0") === 0) {
        return 0;
    }

    const pathOf = makePathOf(db);
    return db
        .query<{ id: number }, []>(
            `SELECT id FROM dirs WHERE (flags & ${DIR_FLAGS.blocked}) != 0 AND (flags & ${GONE}) = 0`
        )
        .all()
        .filter((r) => isUnder(dir, pathOf(r.id))).length;
}

export interface QueryOptions {
    db: string;
    path?: string;
    children?: boolean;
    sort?: QuerySort;
    limit?: number;
    minBytes?: number;
    /** Epoch seconds: only children with a file modified at or after this. */
    changedSince?: number;
    topFiles?: number;
    now?: () => number;
}

function emptyAsOf(): AsOf {
    return {
        scan_id: 0,
        kind: "build",
        status: "none",
        finished_at_ms: null,
        age_s: null,
        last_build_scan_id: null,
        last_build_at_ms: null,
    };
}

function storedChildCounts(db: Database, ids: number[]): Map<number, number> {
    if (ids.length === 0) {
        return new Map();
    }

    const rows = db
        .query<{ parent_id: number; n: number }, [string]>(
            `SELECT parent_id, COUNT(*) AS n FROM dirs
             WHERE parent_id IN (SELECT value FROM json_each(?)) AND (flags & ${GONE}) = 0 GROUP BY parent_id`
        )
        .all(SafeJSON.stringify(ids));
    return new Map(rows.map((r) => [r.parent_id, r.n]));
}

/** Big files under `dir`, largest first: a range scan on the path key, so the cost is the big files below `dir`. */
export function topFilesUnder(db: Database, dir: string, limit: number): TopFile[] {
    if (limit <= 0) {
        return [];
    }

    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const upper = `${prefix.slice(0, -1)}0`;
    return db
        .query<TopFile, [string, string, number]>(
            `SELECT path, logical_bytes, alloc_bytes, mtime_ms, nlink FROM big_files
             WHERE path >= ? AND path < ? ORDER BY alloc_bytes DESC, path LIMIT ?`
        )
        .all(prefix, upper, limit);
}

/** One directory and its stored children, or where a folded path's bytes are counted. */
export function queryPath(opts: QueryOptions): QueryFound | QueryNotFound {
    const now = opts.now ?? Date.now;
    const db = openIndexDbForRead(opts.db);
    try {
        db.exec("BEGIN");
        const root = requireBuilt(db, opts.db);
        const asOf = readAsOf(db, now()) ?? emptyAsOf();
        const path = opts.path ? canonicalPath(opts.path) : root.name;
        const found = findStored(db, root, path);
        if (!found?.exact) {
            const reason = !found ? "outside_root" : existsSync(path) ? "folded" : "missing";
            return {
                schema_version: SCHEMA_VERSION,
                found: false,
                as_of: asOf,
                root: root.name,
                path,
                reason,
                folded_in: found ? found.rowPath : null,
                hint: toolCommand("du clonesize", path, "--depth", "1"),
            };
        }

        const row = found.row;
        const sums = db
            .query<
                { a: number | null; l: number | null; v: number | null; c: number | null; d: number | null; n: number },
                [number]
            >(
                `SELECT SUM(alloc_bytes) AS a, SUM(logical_bytes) AS l, SUM(private_bytes) AS v, SUM(files) AS c,
                        SUM(dirs) AS d, COUNT(*) AS n
                 FROM dirs WHERE parent_id = ? AND (flags & ${GONE}) = 0`
            )
            .get(row.id);
        const n = sums?.n ?? 0;
        const local: LocalOut = {
            alloc_bytes: row.alloc_bytes - (sums?.a ?? 0),
            logical_bytes: row.logical_bytes - (sums?.l ?? 0),
            private_bytes: row.private_bytes === null ? null : row.private_bytes - (sums?.v ?? 0),
            files: row.files - (sums?.c ?? 0),
            dirs: row.dirs - ((sums?.d ?? 0) + n),
        };

        const limit = opts.limit ?? 200;
        let children: ChildOut[] = [];
        let truncated = false;
        if (opts.children !== false) {
            const where = [`parent_id = ?`, `(flags & ${GONE}) = 0`];
            const params: number[] = [row.id];
            if (opts.minBytes !== undefined && opts.minBytes > 0) {
                where.push("alloc_bytes >= ?");
                params.push(opts.minBytes);
            }

            if (opts.changedSince !== undefined && opts.changedSince > 0) {
                where.push("newest_mtime_s >= ?");
                params.push(opts.changedSince);
            }

            params.push(limit + 1);
            const rows = db
                .query<DirRow, number[]>(
                    `SELECT * FROM dirs WHERE ${where.join(" AND ")} ORDER BY ${ORDER_BY[opts.sort ?? "alloc"]} LIMIT ?`
                )
                .all(...params);
            truncated = rows.length > limit;
            const kept = rows.slice(0, limit);
            // Attention flags bypass size/time filters, but share the response budget.
            // Exclude selected rows in SQL before the limit so duplicates cannot consume the remaining slots.
            const remaining = Math.max(0, limit - kept.length);
            const flagged = db
                .query<DirRow, [number, string, number]>(
                    `SELECT * FROM dirs WHERE parent_id = ? AND (flags & ${GONE}) = 0 AND (flags & ${ATTENTION_FLAGS}) != 0
                     AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY name LIMIT ?`
                )
                .all(row.id, SafeJSON.stringify(kept.map((child) => child.id)), remaining + 1);
            truncated ||= flagged.length > remaining;
            for (const f of flagged.slice(0, remaining)) {
                kept.push(f);
            }
            const counts = storedChildCounts(
                db,
                kept.map((r) => r.id)
            );
            children = kept.map((c) => ({
                ...nodeOut(c, join(found.rowPath, c.name), counts.get(c.id) ?? 0),
                share: row.alloc_bytes > 0 ? Math.round((c.alloc_bytes / row.alloc_bytes) * 10000) / 10000 : 0,
            }));
        }

        return {
            schema_version: SCHEMA_VERSION,
            found: true,
            as_of: asOf,
            root: root.name,
            path: found.rowPath,
            node: nodeOut(row, found.rowPath, n),
            local,
            children,
            top_files: topFilesUnder(db, found.rowPath, opts.topFiles ?? 10),
            truncated,
            blocked_below: blockedBelow(db, found.rowPath),
        };
    } finally {
        if (db.inTransaction) {
            db.exec("ROLLBACK");
        }
        db.close();
    }
}

/**
 * The global lists. `dirs` ranks by LOCAL bytes (the directory's own files plus
 * its folded subfolders), because ranking by subtree bytes only repeats the root
 * and its ancestors.
 */
export function queryLargest(opts: {
    db: string;
    largest: "dirs" | "files";
    limit?: number;
    now?: () => number;
}): QueryLargest {
    const now = opts.now ?? Date.now;
    const db = openIndexDbForRead(opts.db);
    try {
        db.exec("BEGIN");
        const root = requireBuilt(db, opts.db);
        const asOf = readAsOf(db, now()) ?? emptyAsOf();
        const limit = opts.limit ?? 50;
        if (opts.largest === "files") {
            const rows = db
                .query<TopFile, [number]>(
                    "SELECT path, logical_bytes, alloc_bytes, mtime_ms, nlink FROM big_files ORDER BY alloc_bytes DESC, path LIMIT ?"
                )
                .all(limit + 1);
            return {
                schema_version: SCHEMA_VERSION,
                as_of: asOf,
                root: root.name,
                largest: "files",
                rows: rows.slice(0, limit),
                truncated: rows.length > limit,
            };
        }

        const rows = db
            .query<DirRow & { local_alloc_bytes: number }, [number]>(
                `SELECT d.*, d.alloc_bytes - COALESCE(
                   (SELECT SUM(c.alloc_bytes) FROM dirs c WHERE c.parent_id = d.id AND (c.flags & ${GONE}) = 0), 0
                 ) AS local_alloc_bytes
                 FROM dirs d WHERE (d.flags & ${GONE}) = 0 ORDER BY local_alloc_bytes DESC, d.id LIMIT ?`
            )
            .all(limit + 1);
        const kept = rows.slice(0, limit);
        const counts = storedChildCounts(
            db,
            kept.map((r) => r.id)
        );
        const pathOf = makePathOf(db);
        const out: LargestDirRow[] = kept.map((r) => ({
            ...nodeOut(r, pathOf(r.id), counts.get(r.id) ?? 0),
            local_alloc_bytes: r.local_alloc_bytes,
        }));
        return {
            schema_version: SCHEMA_VERSION,
            as_of: asOf,
            root: root.name,
            largest: "dirs",
            rows: out,
            truncated: rows.length > limit,
        };
    } finally {
        if (db.inTransaction) {
            db.exec("ROLLBACK");
        }
        db.close();
    }
}

/** Metadata, row counts and recent scans. Answers even before the first build finished. */
export function queryInfo(opts: { db: string; scans?: number; now?: () => number }): QueryInfo {
    const now = opts.now ?? Date.now;
    const db = openIndexDbForRead(opts.db);
    try {
        db.exec("BEGIN");
        const count = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
        const meta = allMeta(db);
        const scans = db
            .query<ScanInfo, [number]>(
                `SELECT id, kind, status, started_at_ms, finished_at_ms, files, dirs, alloc_bytes, walk_ms, threads
                 FROM scans ORDER BY id DESC LIMIT ?`
            )
            .all(opts.scans ?? 10);
        return {
            schema_version: SCHEMA_VERSION,
            db: opts.db,
            db_bytes: dbBytes(opts.db),
            root: meta.root ?? "",
            as_of: readAsOf(db, now()),
            meta,
            counts: {
                dirs: count(`SELECT COUNT(*) AS n FROM dirs WHERE (flags & ${GONE}) = 0`),
                tombstones: count(`SELECT COUNT(*) AS n FROM dirs WHERE (flags & ${GONE}) != 0`),
                big_files: count("SELECT COUNT(*) AS n FROM big_files"),
                snapshots: count("SELECT COUNT(*) AS n FROM snapshots"),
                snapshot_dirs: count("SELECT COUNT(*) AS n FROM snapshot_dirs"),
                dirty_queue: count("SELECT COUNT(*) AS n FROM dirty_queue"),
                blocked: count(
                    `SELECT COUNT(*) AS n FROM dirs WHERE (flags & ${DIR_FLAGS.blocked}) != 0 AND (flags & ${GONE}) = 0`
                ),
            },
            scans,
        };
    } finally {
        if (db.inTransaction) {
            db.exec("ROLLBACK");
        }
        db.close();
    }
}
