import type { Database } from "bun:sqlite";
import { parseDuration } from "@genesiscz/utils/format";
import { INDEX_DEFAULTS } from "./build";
import { getMeta, openIndexDbForRead } from "./db";
import { DIR_FLAGS, SCHEMA_VERSION } from "./schema";
import { makePathOf, requireBuilt } from "./store";
import type { DiffResult, DiffRowOut } from "./types";
import { IndexError } from "./types";

interface SnapshotRow {
    id: number;
    taken_at_ms: number;
    alloc_bytes: number;
    files: number;
    floor_bytes: number;
}

interface SideRow {
    dir_id: number;
    alloc_bytes: number;
    files: number;
}

export interface DiffOptions {
    db: string;
    /** Snapshot id, ISO date, or a duration back from now (`7d`). Default: the snapshot before `to`. */
    from?: string;
    /** Snapshot id, or `now` (the live index, updates included). Default `now`. */
    to?: string;
    minDelta?: number;
    limit?: number;
    /** `leaf` drops an ancestor row when one descendant row explains at least 80% of its delta. */
    attribute?: "leaf" | "all";
    now?: () => number;
}

const LEAF_SHARE = 0.8;

function snapshots(db: Database): SnapshotRow[] {
    return db
        .query<SnapshotRow, []>("SELECT id, taken_at_ms, alloc_bytes, files, floor_bytes FROM snapshots ORDER BY id")
        .all();
}

/** Resolves `--from`/`--to` text to a snapshot. `before` limits the default to snapshots older than it. */
function pickSnapshot(all: SnapshotRow[], spec: string | undefined, now: number, before?: number): SnapshotRow {
    if (all.length === 0) {
        throw new IndexError(
            "no_snapshot",
            "The index has no snapshot yet. A build (without --no-snapshot) makes one."
        );
    }

    if (spec === undefined) {
        const older = before === undefined ? all : all.filter((s) => s.id < before);
        const pick = older[older.length - 1];
        if (!pick) {
            throw new IndexError("no_snapshot", "There is no snapshot before the one asked for in --to.");
        }

        return pick;
    }

    if (/^\d+$/.test(spec.trim())) {
        const id = Number(spec.trim());
        const hit = all.find((s) => s.id === id);
        if (!hit) {
            throw new IndexError("no_snapshot", `No snapshot ${id}. Snapshots: ${all.map((s) => s.id).join(", ")}.`);
        }

        return hit;
    }

    const asDate = spec.includes("-") ? Date.parse(spec) : Number.NaN;
    const ms = Number.isFinite(asDate) ? null : parseDuration(spec);
    if (!Number.isFinite(asDate) && (ms === null || ms <= 0)) {
        throw new IndexError(
            "usage",
            `--from/--to takes a snapshot id, an ISO date or a duration like 7d (got "${spec}").`
        );
    }

    const cutoff = Number.isFinite(asDate) ? asDate : now - (ms ?? 0);
    const atOrBefore = all.filter((s) => s.taken_at_ms <= cutoff);
    // Younger index than asked for: compare with the oldest snapshot, and `from.taken_at_ms` says which.
    return atOrBefore[atOrBefore.length - 1] ?? all[0];
}

function sideMap(rows: SideRow[]): Map<number, SideRow> {
    return new Map(rows.map((r) => [r.dir_id, r]));
}

/**
 * What grew and shrank between two snapshots, or between a snapshot and the live
 * index. Only directories at or above the snapshot floor take part; a side below
 * the floor is unknown (null), and the row's delta is then a lower bound on the
 * change (`approx`).
 */
export function diffIndex(opts: DiffOptions): DiffResult {
    const db = openIndexDbForRead(opts.db);
    try {
        db.exec("BEGIN");
        const root = requireBuilt(db, opts.db);
        const now = (opts.now ?? Date.now)();
        const all = snapshots(db);
        const live = opts.to === undefined || opts.to === "now";
        const toSnap = live ? null : pickSnapshot(all, opts.to, now);
        const fromSnap = pickSnapshot(all, opts.from, now, toSnap?.id);
        const floor = Math.max(
            fromSnap.floor_bytes,
            toSnap?.floor_bytes ?? Number(getMeta(db, "snapshot_floor") ?? INDEX_DEFAULTS.snapshotFloor)
        );

        const fromRows = sideMap(
            db
                .query<SideRow, [number]>("SELECT dir_id, alloc_bytes, files FROM snapshot_dirs WHERE snapshot_id = ?")
                .all(fromSnap.id)
        );
        const toRows = sideMap(
            live
                ? db
                      .query<SideRow, [number, number]>(
                          `SELECT id AS dir_id, alloc_bytes, files FROM dirs WHERE (flags & ${DIR_FLAGS.gone}) = 0
                           AND (alloc_bytes >= ? OR id IN (SELECT dir_id FROM snapshot_dirs WHERE snapshot_id = ?))`
                      )
                      .all(floor, fromSnap.id)
                : db
                      .query<SideRow, [number]>(
                          "SELECT dir_id, alloc_bytes, files FROM snapshot_dirs WHERE snapshot_id = ?"
                      )
                      .all(toSnap?.id ?? 0)
        );
        const rowState = db.query<{ flags: number; first_scan_id: number }, [number]>(
            "SELECT flags, first_scan_id FROM dirs WHERE id = ?"
        );

        const pathOf = makePathOf(db);
        const rows: DiffRowOut[] = [];
        for (const [id, after] of toRows) {
            const before = fromRows.get(id);
            if (before) {
                const delta = after.alloc_bytes - before.alloc_bytes;
                if (delta === 0) {
                    continue;
                }

                rows.push({
                    path: pathOf(id),
                    before: before.alloc_bytes,
                    after: after.alloc_bytes,
                    delta,
                    status: delta > 0 ? "grown" : "shrunk",
                    files_delta: after.files - before.files,
                    approx: false,
                });
                continue;
            }

            const state = rowState.get(id);
            const isNew = state !== null && state.first_scan_id > fromSnap.id;
            rows.push({
                path: pathOf(id),
                before: isNew ? 0 : null,
                after: after.alloc_bytes,
                delta: isNew ? after.alloc_bytes : Math.max(0, after.alloc_bytes - floor),
                status: isNew ? "new" : "grown",
                files_delta: after.files,
                approx: !isNew,
            });
        }

        for (const [id, before] of fromRows) {
            if (toRows.has(id)) {
                continue;
            }

            // Current tombstones say nothing about existence at a historical snapshot's floor.
            const gone = live;
            rows.push({
                path: pathOf(id),
                before: before.alloc_bytes,
                after: gone ? 0 : null,
                delta: gone ? -before.alloc_bytes : Math.min(0, floor - before.alloc_bytes),
                status: gone ? "gone" : "shrunk",
                files_delta: -before.files,
                approx: !gone,
            });
        }

        const minDelta = opts.minDelta ?? 0;
        let kept = rows.filter((r) => r.delta !== 0 && Math.abs(r.delta) >= minDelta);
        if ((opts.attribute ?? "leaf") === "leaf") {
            kept = attributeToLeaves(kept);
        }

        kept.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path));
        const limit = opts.limit ?? 200;
        const liveRoot = live
            ? db
                  .query<{ alloc_bytes: number; files: number }, [number]>(
                      "SELECT alloc_bytes, files FROM dirs WHERE id = ?"
                  )
                  .get(root.id)
            : null;
        const toAlloc = liveRoot?.alloc_bytes ?? toSnap?.alloc_bytes ?? 0;
        const toFiles = liveRoot?.files ?? toSnap?.files ?? 0;
        const lastScan = db
            .query<{ id: number; finished_at_ms: number | null }, []>(
                "SELECT id, finished_at_ms FROM scans WHERE status = 'done' ORDER BY id DESC LIMIT 1"
            )
            .get() ?? { id: 0, finished_at_ms: null };

        return {
            schema_version: SCHEMA_VERSION,
            root: root.name,
            from: { snapshot_id: fromSnap.id, scan_id: fromSnap.id, taken_at_ms: fromSnap.taken_at_ms },
            to: live
                ? { snapshot_id: null, scan_id: lastScan.id, taken_at_ms: lastScan.finished_at_ms ?? now, live: true }
                : {
                      snapshot_id: toSnap?.id ?? null,
                      scan_id: toSnap?.id ?? 0,
                      taken_at_ms: toSnap?.taken_at_ms ?? 0,
                      live: false,
                  },
            floor,
            attribute: opts.attribute ?? "leaf",
            total_delta: { alloc_bytes: toAlloc - fromSnap.alloc_bytes, files: toFiles - fromSnap.files },
            rows: kept.slice(0, limit),
            truncated: kept.length > limit,
        };
    } finally {
        if (db.inTransaction) {
            db.exec("ROLLBACK");
        }
        db.close();
    }
}

/**
 * Drops a row when a row below it (same direction) already explains at least
 * 80% of its delta, so "Library grew 9 GB" does not crowd out "Docker.raw's
 * folder grew 8.5 GB". Search the prefix interval: a sibling can sort between a parent and its children.
 */
export function attributeToLeaves(rows: DiffRowOut[]): DiffRowOut[] {
    const sorted = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const out: DiffRowOut[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i];
        const prefix = row.path.endsWith("/") ? row.path : `${row.path}/`;
        let explained = false;
        let low = i + 1;
        let high = sorted.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (sorted[middle].path < prefix) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        for (let j = low; j < sorted.length && sorted[j].path.startsWith(prefix); j++) {
            const d = sorted[j].delta;
            if (Math.sign(d) === Math.sign(row.delta) && Math.abs(d) >= LEAF_SHARE * Math.abs(row.delta)) {
                explained = true;
                break;
            }
        }

        if (!explained) {
            out.push(row);
        }
    }

    return out;
}
