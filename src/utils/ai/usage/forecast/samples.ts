import type { Database } from "bun:sqlite";

export interface UsageSample {
    provider: string;
    account: string;
    bucket: string;
    kind: string | null;
    utilization: number;
    resetsAt: string | null;
    timestamp: string;
}

/** One column of `PRAGMA table_info`, as far as the readers here look. */
interface ColumnRow {
    name: string;
}

interface SampleRow {
    provider: string;
    account_name: string;
    bucket: string;
    kind: string | null;
    utilization: number;
    resets_at: string | null;
    timestamp: string;
}

/** A provider and an account name, as `usage_snapshots` keys a window's rows. */
export interface SampleAccount {
    provider: string;
    account: string;
}

export interface UsageSampleQuery {
    since: Date;
    provider?: string;
    account?: string;
    /** Only these provider/account pairs. Omitted: every account; empty: none. */
    accounts?: readonly SampleAccount[];
}

/**
 * Each window's last reading before `before`, oldest first: the baseline a lookback starts from. Readings are written
 * only on a change, so a window idle longer than the lookback has no reading inside it, and a reader that needs the
 * value at the lookback's start (a budget's "used at midnight") would otherwise read 0.
 */
export function readSampleSeeds(db: Database, options: { before: Date }): UsageSample[] {
    const columns = db.prepare<ColumnRow, []>("PRAGMA table_info(usage_snapshots)").all();

    // A history file the usage poll never reached has no `usage_snapshots` yet (the history and the usage store
    // migrate separately, and this read never migrates): no readings, not an error.
    if (columns.length === 0) {
        return [];
    }

    const readingsOnly = columns.some((column) => column.name === "availability")
        ? "AND availability IS NOT 'absent'"
        : "";
    const rows = db
        .prepare(
            `SELECT provider, account_name, bucket, kind, utilization, resets_at, timestamp
             FROM usage_snapshots
             WHERE id IN (
                 SELECT MAX(id) FROM usage_snapshots
                 WHERE timestamp < ?1 ${readingsOnly}
                 GROUP BY provider, account_name, bucket
             )
             ORDER BY timestamp ASC`
        )
        .all(options.before.toISOString()) as SampleRow[];

    return rows.map((row) => ({
        provider: row.provider,
        account: row.account_name,
        bucket: row.bucket,
        kind: row.kind,
        utilization: row.utilization,
        resetsAt: row.resets_at,
        timestamp: row.timestamp,
    }));
}

/** The samples of the lookback, filters in the WHERE clause (never after a full read). */
export function readUsageSamples(db: Database, options: UsageSampleQuery): UsageSample[] {
    if (options.accounts?.length === 0) {
        return [];
    }

    // Numbered from ?4 on, after the three fixed parameters below.
    const pairs = options.accounts ?? [];
    const pairParams = pairs.flatMap((pair) => [pair.provider, pair.account]);
    const pairFilter = pairs.length
        ? `AND (provider, account_name) IN (VALUES ${pairs.map((_, i) => `(?${4 + i * 2}, ?${5 + i * 2})`).join(", ")})`
        : "";
    // A store the availability migration has not reached yet has no such column (this read is
    // read-only and never migrates); its rows are all readings.
    const columns = db.prepare<ColumnRow, []>("PRAGMA table_info(usage_snapshots)").all();

    // No `usage_snapshots` yet (no usage poll on this machine): no readings, as in `readSampleSeeds`.
    if (columns.length === 0) {
        return [];
    }

    const readingsOnly = columns.some((column) => column.name === "availability")
        ? "AND availability IS NOT 'absent'"
        : "";
    const rows = db
        .prepare(
            `SELECT provider, account_name, bucket, kind, utilization, resets_at, timestamp
             FROM usage_snapshots
             WHERE timestamp >= ?1
               AND (?2 IS NULL OR provider = ?2)
               AND (?3 IS NULL OR account_name = ?3)
               ${readingsOnly}
               ${pairFilter}
             ORDER BY timestamp ASC`
        )
        .all(
            options.since.toISOString(),
            options.provider ?? null,
            options.account ?? null,
            ...pairParams
        ) as SampleRow[];

    return rows.map((row) => ({
        provider: row.provider,
        account: row.account_name,
        bucket: row.bucket,
        kind: row.kind,
        utilization: row.utilization,
        resetsAt: row.resets_at,
        timestamp: row.timestamp,
    }));
}
