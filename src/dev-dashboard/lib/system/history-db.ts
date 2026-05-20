import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PulsePoint } from "./types";

const DEFAULT_DB_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "pulse.db");
export const MAX_SERIES_POINTS = 360;

export function downsamplePoints(points: PulsePoint[], maxPoints: number = MAX_SERIES_POINTS): PulsePoint[] {
    if (points.length <= maxPoints || maxPoints < 1) {
        return points;
    }

    const bucketSize = Math.ceil(points.length / maxPoints);
    const result: PulsePoint[] = [];

    for (let i = 0; i < points.length; i += bucketSize) {
        const bucket = points.slice(i, i + bucketSize);
        const avg = bucket.reduce((sum, point) => sum + point.value, 0) / bucket.length;
        const mid = bucket[Math.floor(bucket.length / 2)];

        result.push({ ts: mid.ts, value: Math.round(avg * 100) / 100 });
    }

    return result;
}

interface PointRow {
    ts: string;
    value: number;
}

interface KvRow {
    v: string;
    updated_at: string;
}

interface CountRow {
    n: number;
}

export class PulseHistoryDb {
    private db: Database;

    constructor(dbPath: string = DEFAULT_DB_PATH) {
        if (dbPath !== ":memory:") {
            mkdirSync(dirname(dbPath), { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.run(
            "CREATE TABLE IF NOT EXISTS pulse_points (metric TEXT NOT NULL, ts TEXT NOT NULL, value REAL NOT NULL)"
        );
        this.db.run("CREATE INDEX IF NOT EXISTS idx_pp ON pulse_points(metric, ts)");
        this.db.run("CREATE TABLE IF NOT EXISTS pulse_kv (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)");
    }

    record(metric: string, value: number): void {
        this.recordAt(metric, value, new Date().toISOString());
    }

    recordAt(metric: string, value: number, ts: string): void {
        this.db.prepare("INSERT INTO pulse_points (metric, ts, value) VALUES (?, ?, ?)").run(metric, ts, value);
    }

    series(metric: string, minutes: number, maxPoints: number = MAX_SERIES_POINTS): PulsePoint[] {
        const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
        const rows = this.db
            .prepare("SELECT ts, value FROM pulse_points WHERE metric = ? AND ts >= ? ORDER BY ts ASC")
            .all(metric, cutoff) as PointRow[];
        return downsamplePoints(
            rows.map((r) => ({ ts: r.ts, value: r.value })),
            maxPoints
        );
    }

    pruneOlderThan(hours: number): number {
        const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
        const before = this.db.prepare("SELECT COUNT(*) AS n FROM pulse_points WHERE ts < ?").get(cutoff) as CountRow;
        this.db.prepare("DELETE FROM pulse_points WHERE ts < ?").run(cutoff);
        return before.n;
    }

    getPublicIp(maxAgeMs: number): string | null {
        const row = this.db.prepare("SELECT v, updated_at FROM pulse_kv WHERE k = 'public_ip'").get() as KvRow | null;

        if (!row || !row.v) {
            return null;
        }

        const updatedAtMs = new Date(row.updated_at).getTime();

        if (Number.isNaN(updatedAtMs)) {
            return null;
        }

        const age = Date.now() - updatedAtMs;

        if (age > maxAgeMs) {
            return null;
        }

        return row.v;
    }

    setPublicIp(ip: string): void {
        this.db
            .prepare(
                "INSERT INTO pulse_kv (k, v, updated_at) VALUES ('public_ip', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at"
            )
            .run(ip, new Date().toISOString());
    }

    close(): void {
        this.db.close();
    }
}
