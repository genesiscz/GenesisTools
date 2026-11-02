import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Migration, runMigrations } from "@genesiscz/utils/database/migrations";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import type { AlertCategory, WazeAlert } from "./types";

const { log } = logger.scoped("waze-store");

export const WAZE_MIGRATIONS: Migration[] = [
    {
        id: "001-snapshots-and-alerts",
        description: "one row per recorded snapshot, and one row per distinct Waze report with first and last sighting",
        apply: (db) => {
            db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                taken_at INTEGER NOT NULL,
                kind TEXT NOT NULL,
                label TEXT NOT NULL,
                area_json TEXT NOT NULL,
                alerts INTEGER NOT NULL,
                jams INTEGER NOT NULL,
                police INTEGER NOT NULL
            );`);
            db.exec("CREATE INDEX IF NOT EXISTS idx_snapshots_taken ON snapshots(taken_at);");
            db.exec(`CREATE TABLE IF NOT EXISTS alerts (
                alert_id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                type TEXT NOT NULL,
                subtype TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                street TEXT,
                published_at INTEGER NOT NULL,
                thumbs_up INTEGER NOT NULL,
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                sightings INTEGER NOT NULL,
                last_snapshot INTEGER NOT NULL
            );`);
            db.exec("CREATE INDEX IF NOT EXISTS idx_alerts_category ON alerts(category, published_at);");
        },
    },
];

export interface SnapshotInput {
    kind: "area" | "route";
    label: string;
    area: unknown;
    alerts: WazeAlert[];
    jams: number;
    takenAt?: number;
}

export interface SnapshotRow {
    id: number;
    takenAt: number;
    kind: string;
    label: string;
    alerts: number;
    jams: number;
    police: number;
}

export interface HotspotRow {
    lat: number;
    lon: number;
    street: string | null;
    reports: number;
    /** Local hours of day with the most reports in this cell, most first. */
    topHours: number[];
    lastSeen: number;
}

export interface HourRow {
    hour: number;
    reports: number;
}

export function wazeDbPath(): string {
    return toolDataDir("waze", "waze.db");
}

/** Recorded snapshots and every distinct report seen in them, in `~/.genesis-tools/waze/waze.db`. */
export class WazeStore {
    private constructor(readonly db: Database) {}

    static open(path = wazeDbPath()): WazeStore {
        if (path !== ":memory:") {
            mkdirSync(dirname(path), { recursive: true });
        }

        const db = new Database(path, { create: true });
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec("PRAGMA busy_timeout = 5000;");
        runMigrations(db, WAZE_MIGRATIONS, { tableName: "waze" });
        log.debug({ path }, "waze store opened");
        return new WazeStore(db);
    }

    /** The store for reading only (history, hotspots): undefined when nothing was recorded yet, never created here. */
    static openReadOnly(path = wazeDbPath()): WazeStore | undefined {
        if (!existsSync(path)) {
            log.debug({ path }, "waze store not created yet");
            return undefined;
        }

        return new WazeStore(new Database(path, { readonly: true }));
    }

    close(): void {
        this.db.close();
    }

    /** Saves one snapshot; a report seen before gets its sighting count and last-seen time raised. */
    record(input: SnapshotInput): SnapshotRow {
        const takenAt = input.takenAt ?? Date.now();
        const police = input.alerts.filter((alert) => alert.category === "police").length;
        const insertSnapshot = this.db.query(
            "INSERT INTO snapshots (taken_at, kind, label, area_json, alerts, jams, police) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
        );
        const upsert = this.db.query(`INSERT INTO alerts
            (alert_id, category, type, subtype, lat, lon, street, published_at, thumbs_up, first_seen, last_seen, sightings, last_snapshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(alert_id) DO UPDATE SET
                last_seen = excluded.last_seen,
                thumbs_up = excluded.thumbs_up,
                sightings = alerts.sightings + (alerts.last_snapshot != excluded.last_snapshot),
                last_snapshot = excluded.last_snapshot`);
        const id = this.db.transaction(() => {
            const row = insertSnapshot.get(
                takenAt,
                input.kind,
                input.label,
                SafeJSON.stringify(input.area),
                input.alerts.length,
                input.jams,
                police
            );
            const snapshotId = typeof row === "object" && row !== null && "id" in row ? Number(row.id) : 0;
            for (const alert of input.alerts) {
                upsert.run(
                    alert.id,
                    alert.category,
                    alert.type,
                    alert.subtype,
                    alert.lat,
                    alert.lon,
                    alert.street ?? null,
                    alert.publishedAt,
                    alert.thumbsUp,
                    takenAt,
                    takenAt,
                    snapshotId
                );
            }

            return snapshotId;
        })();
        log.debug({ id, kind: input.kind, label: input.label, alerts: input.alerts.length }, "waze snapshot recorded");
        return {
            id,
            takenAt,
            kind: input.kind,
            label: input.label,
            alerts: input.alerts.length,
            jams: input.jams,
            police,
        };
    }

    snapshots(limit = 20): SnapshotRow[] {
        return this.db
            .query<
                {
                    id: number;
                    taken_at: number;
                    kind: string;
                    label: string;
                    alerts: number;
                    jams: number;
                    police: number;
                },
                [number]
            >("SELECT id, taken_at, kind, label, alerts, jams, police FROM snapshots ORDER BY taken_at DESC LIMIT ?")
            .all(limit)
            .map((row) => ({
                id: row.id,
                takenAt: row.taken_at,
                kind: row.kind,
                label: row.label,
                alerts: row.alerts,
                jams: row.jams,
                police: row.police,
            }));
    }

    counts(): { snapshots: number; alerts: number; police: number } {
        const row = this.db
            .query<{ snapshots: number; alerts: number; police: number }, []>(
                `SELECT (SELECT COUNT(*) FROM snapshots) AS snapshots,
                        (SELECT COUNT(*) FROM alerts) AS alerts,
                        (SELECT COUNT(*) FROM alerts WHERE category = 'police') AS police`
            )
            .get();
        return row ?? { snapshots: 0, alerts: 0, police: 0 };
    }

    /**
     * Places with the most distinct reports of a category, on a grid of `cellDeg` degrees (0.01 is about 1.1 km north
     * to south), with the local hours that had most reports. `sinceMs` bounds the report time in SQL.
     */
    hotspots(opts: { category: AlertCategory; cellDeg?: number; sinceMs?: number; limit?: number }): HotspotRow[] {
        const cell = opts.cellDeg ?? 0.01;
        const rows = this.db
            .query<
                {
                    cell_lat: number;
                    cell_lon: number;
                    reports: number;
                    street: string | null;
                    last_seen: number;
                    hours: string;
                },
                [number, number, string, number, number]
            >(
                `SELECT ROUND(lat / ?) AS cell_lat, ROUND(lon / ?) AS cell_lon, COUNT(*) AS reports,
                        MAX(street) AS street, MAX(last_seen) AS last_seen,
                        GROUP_CONCAT(published_at) AS hours
                 FROM alerts
                 WHERE category = ? AND published_at >= ?
                 GROUP BY cell_lat, cell_lon
                 ORDER BY reports DESC
                 LIMIT ?`
            )
            .all(cell, cell, opts.category, opts.sinceMs ?? 0, opts.limit ?? 15);
        return rows.map((row) => ({
            lat: row.cell_lat * cell,
            lon: row.cell_lon * cell,
            street: row.street,
            reports: row.reports,
            topHours: topHours(row.hours),
            lastSeen: row.last_seen,
        }));
    }

    /** Distinct reports of a category per local hour of day (0-23), every hour present. */
    hourHistogram(opts: { category: AlertCategory; sinceMs?: number }): HourRow[] {
        const rows = this.db
            .query<{ published_at: number }, [string, number]>(
                "SELECT published_at FROM alerts WHERE category = ? AND published_at >= ?"
            )
            .all(opts.category, opts.sinceMs ?? 0);
        const counts = new Array<number>(24).fill(0);
        for (const row of rows) {
            const hour = localHour(row.published_at);
            counts[hour] = (counts[hour] ?? 0) + 1;
        }

        return counts.map((reports, hour) => ({ hour, reports }));
    }
}

/**
 * The hour of day in this process's time zone. Computed here, not with SQLite's `localtime`, which reads the OS zone
 * and can disagree with the process (`TZ`), so the hours always match the times the CLI prints.
 */
function localHour(epochMs: number): number {
    return new Date(epochMs).getHours();
}

/** The three hours of day with most reports, from a comma list of report times (epoch ms). */
function topHours(list: string | null): number[] {
    if (!list) {
        return [];
    }

    const counts = new Map<number, number>();
    for (const part of list.split(",")) {
        const publishedAt = Number(part);
        if (Number.isFinite(publishedAt)) {
            const hour = localHour(publishedAt);
            counts.set(hour, (counts.get(hour) ?? 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, 3)
        .map(([hour]) => hour);
}
