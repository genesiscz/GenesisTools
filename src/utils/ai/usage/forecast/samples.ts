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

interface SampleRow {
    provider: string;
    account_name: string;
    bucket: string;
    kind: string | null;
    utilization: number;
    resets_at: string | null;
    timestamp: string;
}

/** The samples of the lookback, filters in the WHERE clause (never after a full read). */
export function readUsageSamples(
    db: Database,
    options: { since: Date; provider?: string; account?: string }
): UsageSample[] {
    // A store the availability migration has not reached yet has no such column (this read is
    // read-only and never migrates); its rows are all readings.
    const columns = db.prepare("PRAGMA table_info(usage_snapshots)").all() as Array<{ name: string }>;
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
             ORDER BY timestamp ASC`
        )
        .all(options.since.toISOString(), options.provider ?? null, options.account ?? null) as SampleRow[];

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
