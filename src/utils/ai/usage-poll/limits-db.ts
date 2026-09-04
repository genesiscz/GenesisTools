import type { Database } from "bun:sqlite";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { USAGE_LIMITS_MIGRATIONS } from "./migrations";

const schemaEnsured = new WeakSet<Database>();

/**
 * Rows written before the provider column existed are anthropic. The column default in
 * `2026-09-usage-limits-provider` is the same string, so a read that omits `provider`
 * still sees every historical row.
 */
export const DEFAULT_LIMITS_PROVIDER = "anthropic-sub";

export interface UsageSnapshot {
    id: number;
    timestamp: string;
    accountName: string;
    bucket: string;
    utilization: number;
    resetsAt: string | null;
    severity: string | null;
    scopeModel: string | null;
    provider: string;
    accountId: string | null;
    kind: string | null;
    moneyUsedMinor: number | null;
    moneyLimitMinor: number | null;
    moneyCurrency: string | null;
}

export interface SnapshotV2Extras {
    resetsAt: string | null;
    severity: string | null;
    scopeModel: string | null;
    /** Plugin id. Defaults to `anthropic-sub` so pre-existing callers keep their rows. */
    provider?: string;
    /** `AccountEntry.id` when the caller knows it. Additive; rows stay keyed by NAME. */
    accountId?: string | null;
    /** `LimitWindow.kind`. */
    kind?: string | null;
    money?: { usedMinor: number; limitMinor?: number | null; currency: string } | null;
}

export interface SpendInput {
    used_minor: number;
    used_currency: string;
    used_exponent: number;
    limit_minor: number | null;
    limit_exponent: number | null;
    percent: number;
    severity: string;
    enabled: boolean;
    cap_minor: number | null;
    cap_currency: string | null;
}

export interface SpendSnapshot extends SpendInput {
    id: number;
    timestamp: string;
    accountName: string;
}

export interface SeriesQuery {
    provider?: string;
    accounts?: string[];
    /** `LimitWindow.key` values, stored in the `bucket` column. */
    keys?: string[];
    /** ISO timestamps. */
    from: string;
    to: string;
    /** Downsample width in ms. Omitted means every row. */
    step?: number;
}

export interface SeriesPoint {
    t: string;
    percent: number;
}

export interface SeriesEntry {
    account: string;
    key: string;
    points: SeriesPoint[];
}

interface SnapshotRow {
    id: number;
    timestamp: string;
    account_name: string;
    bucket: string;
    utilization: number;
    resets_at: string | null;
    severity: string | null;
    scope_model: string | null;
    provider: string | null;
    account_id: string | null;
    kind: string | null;
    money_used_minor: number | null;
    money_limit_minor: number | null;
    money_currency: string | null;
}

interface SpendRow {
    id: number;
    timestamp: string;
    account_name: string;
    used_minor: number;
    used_currency: string;
    used_exponent: number;
    limit_minor: number | null;
    limit_exponent: number | null;
    percent: number;
    severity: string;
    enabled: number;
    cap_minor: number | null;
    cap_currency: string | null;
}

const SNAPSHOT_COLUMNS = `id, timestamp, account_name, bucket, utilization, resets_at, severity, scope_model,
                   provider, account_id, kind, money_used_minor, money_limit_minor, money_currency`;

/**
 * API `resets_at` strings jitter by up to ~1.6s between polls (observed empirically
 * across 5944 same-utilization/severity snapshot pairs, max diff 1606ms) even when the
 * reset window hasn't changed. Flooring to the second (a prior fix) still misclassifies
 * jitter that straddles a whole-second boundary (e.g. 03:59:59.9 vs 04:00:00.1) as a
 * change. Use a tolerance well above the observed jitter but far below any real window
 * shift (hours/days) instead.
 */
const RESETS_AT_JITTER_TOLERANCE_MS = 5_000;

export function resetsAtRoughlyEqual(a: string | null, b: string | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }

    const msA = Date.parse(a);
    const msB = Date.parse(b);

    if (Number.isNaN(msA) || Number.isNaN(msB)) {
        return a === b;
    }

    return Math.abs(msA - msB) <= RESETS_AT_JITTER_TOLERANCE_MS;
}

/**
 * The limits store (spec 2026-09-04 section 6.2): percent-of-window snapshots per account
 * per limit window, plus the subscription spend rows. Provider-neutral since the
 * `2026-09-usage-limits-provider` migration; rows stay keyed by account NAME so
 * `renameAccount` keeps a burn history intact across a rename.
 *
 * Same SQLite file as before (decision D8): `~/.genesis-tools/claude-history/index.db`.
 */
export class UsageLimitsDb {
    private claudeDb: ClaudeDatabase;

    constructor(dbPath?: string) {
        this.claudeDb = dbPath ? new ClaudeDatabase(dbPath) : ClaudeDatabase.getInstance();
        this.ensureSchema();
    }

    private ensureSchema(): void {
        const db = this.claudeDb.getDb();

        if (schemaEnsured.has(db)) {
            return;
        }

        db.exec(`
            CREATE TABLE IF NOT EXISTS usage_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                account_name TEXT NOT NULL,
                bucket TEXT NOT NULL,
                utilization REAL NOT NULL,
                resets_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_time
                ON usage_snapshots(timestamp);
            CREATE INDEX IF NOT EXISTS idx_snapshots_account_bucket
                ON usage_snapshots(account_name, bucket);
            CREATE INDEX IF NOT EXISTS idx_snapshots_lookup
                ON usage_snapshots(account_name, bucket, timestamp);
            CREATE TABLE IF NOT EXISTS spend_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                account_name TEXT NOT NULL,
                used_minor INTEGER NOT NULL,
                used_currency TEXT NOT NULL,
                used_exponent INTEGER NOT NULL,
                limit_minor INTEGER,
                limit_exponent INTEGER,
                percent REAL NOT NULL,
                severity TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                cap_minor INTEGER,
                cap_currency TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_spend_lookup
                ON spend_snapshots(account_name, timestamp);
        `);

        // SQLite has no ADD COLUMN IF NOT EXISTS — guard with PRAGMA table_info.
        const cols = db.prepare("PRAGMA table_info(usage_snapshots)").all() as Array<{ name: string }>;
        const have = new Set(cols.map((c) => c.name));

        if (!have.has("severity")) {
            db.exec("ALTER TABLE usage_snapshots ADD COLUMN severity TEXT");
        }

        if (!have.has("scope_model")) {
            db.exec("ALTER TABLE usage_snapshots ADD COLUMN scope_model TEXT");
        }

        runMigrations(db, USAGE_LIMITS_MIGRATIONS, { tableName: "usage_limits" });

        schemaEnsured.add(db);
    }

    recordSnapshot(
        accountName: string,
        bucket: string,
        utilization: number,
        timestamp: string,
        resetsAt?: string | null
    ): number {
        return this.recordSnapshotV2(accountName, bucket, utilization, timestamp, {
            resetsAt: resetsAt ?? null,
            severity: null,
            scopeModel: null,
        });
    }

    recordSnapshotV2(
        accountName: string,
        bucket: string,
        utilization: number,
        timestamp: string,
        extras: SnapshotV2Extras
    ): number {
        const stmt = this.claudeDb.getDb().prepare(`
            INSERT INTO usage_snapshots
                (timestamp, account_name, bucket, utilization, resets_at, severity, scope_model,
                 provider, account_id, kind, money_used_minor, money_limit_minor, money_currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            timestamp,
            accountName,
            bucket,
            utilization,
            extras.resetsAt,
            extras.severity,
            extras.scopeModel,
            extras.provider ?? DEFAULT_LIMITS_PROVIDER,
            extras.accountId ?? null,
            extras.kind ?? null,
            extras.money?.usedMinor ?? null,
            extras.money?.limitMinor ?? null,
            extras.money?.currency ?? null
        );

        return Number(result.lastInsertRowid);
    }

    recordIfChanged(accountName: string, bucket: string, utilization: number, resetsAt: string | null): boolean {
        return this.recordIfChangedV2(accountName, bucket, utilization, {
            resetsAt,
            severity: null,
            scopeModel: null,
        });
    }

    recordIfChangedV2(accountName: string, bucket: string, utilization: number, extras: SnapshotV2Extras): boolean {
        const latest = this.getLatest(accountName, bucket, extras.provider);

        if (
            latest &&
            latest.utilization === utilization &&
            latest.severity === extras.severity &&
            resetsAtRoughlyEqual(latest.resetsAt, extras.resetsAt)
        ) {
            return false;
        }

        this.recordSnapshotV2(accountName, bucket, utilization, new Date().toISOString(), extras);
        return true;
    }

    getLatest(accountName: string, bucket: string, provider?: string): UsageSnapshot | null {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT ${SNAPSHOT_COLUMNS}
            FROM usage_snapshots
            WHERE account_name = ?1 AND bucket = ?2
              AND (?3 IS NULL OR provider = ?3)
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const row = stmt.get(accountName, bucket, provider ?? null) as SnapshotRow | null;

        if (!row) {
            return null;
        }

        return this.mapRow(row);
    }

    getSnapshots(accountName: string, bucket: string, lastMinutes: number, provider?: string): UsageSnapshot[] {
        const cutoff = new Date(Date.now() - lastMinutes * 60_000).toISOString();
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT ${SNAPSHOT_COLUMNS}
            FROM usage_snapshots
            WHERE account_name = ?1 AND bucket = ?2
              AND timestamp >= ?3
              AND (?4 IS NULL OR provider = ?4)
            ORDER BY timestamp ASC
        `);
        const rows = stmt.all(accountName, bucket, cutoff, provider ?? null) as SnapshotRow[];

        return rows.map((row) => this.mapRow(row));
    }

    getAllAccountBuckets(provider?: string): Array<{ accountName: string; bucket: string; provider: string }> {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT DISTINCT account_name, bucket, provider
            FROM usage_snapshots
            WHERE (?1 IS NULL OR provider = ?1)
            ORDER BY account_name, bucket
        `);
        const rows = stmt.all(provider ?? null) as Array<{
            account_name: string;
            bucket: string;
            provider: string | null;
        }>;

        return rows.map((r) => ({
            accountName: r.account_name,
            bucket: r.bucket,
            provider: r.provider ?? DEFAULT_LIMITS_PROVIDER,
        }));
    }

    /**
     * Percent-over-time per (account, window key), for the dashboard charts (spec 9.4).
     * `step` downsamples by keeping the last sample of each fixed-width bucket, so a 7-day
     * range does not return 20k points.
     */
    getSeries(query: SeriesQuery): SeriesEntry[] {
        const where: string[] = ["timestamp >= ?", "timestamp <= ?"];
        const params: Array<string | null> = [query.from, query.to];

        if (query.provider) {
            where.push("provider = ?");
            params.push(query.provider);
        }

        if (query.accounts && query.accounts.length > 0) {
            where.push(`account_name IN (${query.accounts.map(() => "?").join(", ")})`);
            params.push(...query.accounts);
        }

        if (query.keys && query.keys.length > 0) {
            where.push(`bucket IN (${query.keys.map(() => "?").join(", ")})`);
            params.push(...query.keys);
        }

        const stmt = this.claudeDb.getDb().prepare(`
            SELECT account_name, bucket, timestamp, utilization
            FROM usage_snapshots
            WHERE ${where.join(" AND ")}
            ORDER BY account_name, bucket, timestamp ASC
        `);
        const rows = stmt.all(...params) as Array<{
            account_name: string;
            bucket: string;
            timestamp: string;
            utilization: number;
        }>;

        const byKey = new Map<string, SeriesEntry>();

        for (const row of rows) {
            const mapKey = `${row.account_name} ${row.bucket}`;
            let entry = byKey.get(mapKey);

            if (!entry) {
                entry = { account: row.account_name, key: row.bucket, points: [] };
                byKey.set(mapKey, entry);
            }

            entry.points.push({ t: row.timestamp, percent: row.utilization });
        }

        const entries = [...byKey.values()];

        if (!query.step || query.step <= 0) {
            return entries;
        }

        for (const entry of entries) {
            entry.points = downsample(entry.points, query.step);
        }

        return entries;
    }

    /**
     * Re-key every row of a renamed account, in ONE transaction. History is
     * keyed by account NAME, so a rename that skips this silently splits an
     * account's burn history in two and the observed pace restarts from zero.
     * Returns the number of rows moved.
     */
    renameAccount(oldName: string, newName: string): number {
        const db = this.claudeDb.getDb();

        const rekey = db.transaction(() => {
            const usage = db.prepare("UPDATE usage_snapshots SET account_name = ?2 WHERE account_name = ?1");
            const spend = db.prepare("UPDATE spend_snapshots SET account_name = ?2 WHERE account_name = ?1");

            usage.run(oldName, newName);
            const afterUsage = db.prepare("SELECT changes() AS n").get() as { n: number };

            spend.run(oldName, newName);
            const afterSpend = db.prepare("SELECT changes() AS n").get() as { n: number };

            return afterUsage.n + afterSpend.n;
        });

        return rekey();
    }

    pruneOlderThan(days: number): number {
        const usagePruned = this.claudeDb.pruneTable("usage_snapshots", "timestamp", days);
        const spendPruned = this.claudeDb.pruneTable("spend_snapshots", "timestamp", days);

        return usagePruned + spendPruned;
    }

    recordSpendIfChanged(accountName: string, spend: SpendInput, provider?: string): boolean {
        const latest = this.getLatestSpend(accountName, provider);

        if (
            latest &&
            latest.used_minor === spend.used_minor &&
            latest.used_currency === spend.used_currency &&
            latest.used_exponent === spend.used_exponent &&
            latest.percent === spend.percent &&
            latest.severity === spend.severity &&
            latest.enabled === spend.enabled &&
            latest.limit_minor === spend.limit_minor &&
            latest.limit_exponent === spend.limit_exponent &&
            latest.cap_minor === spend.cap_minor &&
            latest.cap_currency === spend.cap_currency
        ) {
            return false;
        }

        const stmt = this.claudeDb.getDb().prepare(`
            INSERT INTO spend_snapshots
                (timestamp, account_name, used_minor, used_currency, used_exponent,
                 limit_minor, limit_exponent, percent, severity, enabled, cap_minor, cap_currency, provider)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            new Date().toISOString(),
            accountName,
            spend.used_minor,
            spend.used_currency,
            spend.used_exponent,
            spend.limit_minor,
            spend.limit_exponent,
            spend.percent,
            spend.severity,
            spend.enabled ? 1 : 0,
            spend.cap_minor,
            spend.cap_currency,
            provider ?? DEFAULT_LIMITS_PROVIDER
        );

        return true;
    }

    getLatestSpend(accountName: string, provider?: string): SpendSnapshot | null {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT id, timestamp, account_name, used_minor, used_currency, used_exponent,
                   limit_minor, limit_exponent, percent, severity, enabled, cap_minor, cap_currency
            FROM spend_snapshots
            WHERE account_name = ?1
              AND (?2 IS NULL OR provider = ?2)
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const row = stmt.get(accountName, provider ?? null) as SpendRow | null;

        if (!row) {
            return null;
        }

        return {
            id: row.id,
            timestamp: row.timestamp,
            accountName: row.account_name,
            used_minor: row.used_minor,
            used_currency: row.used_currency,
            used_exponent: row.used_exponent,
            limit_minor: row.limit_minor,
            limit_exponent: row.limit_exponent,
            percent: row.percent,
            severity: row.severity,
            enabled: row.enabled === 1,
            cap_minor: row.cap_minor,
            cap_currency: row.cap_currency,
        };
    }

    close(): void {
        this.claudeDb.close();
    }

    private mapRow(row: SnapshotRow): UsageSnapshot {
        return {
            id: row.id,
            timestamp: row.timestamp,
            accountName: row.account_name,
            bucket: row.bucket,
            utilization: row.utilization,
            resetsAt: row.resets_at,
            severity: row.severity,
            scopeModel: row.scope_model,
            provider: row.provider ?? DEFAULT_LIMITS_PROVIDER,
            accountId: row.account_id,
            kind: row.kind,
            moneyUsedMinor: row.money_used_minor,
            moneyLimitMinor: row.money_limit_minor,
            moneyCurrency: row.money_currency,
        };
    }
}

function downsample(points: SeriesPoint[], step: number): SeriesPoint[] {
    const out: SeriesPoint[] = [];
    let currentBucket: number | null = null;

    for (const point of points) {
        const bucket = Math.floor(Date.parse(point.t) / step);

        if (bucket === currentBucket) {
            out[out.length - 1] = point;
            continue;
        }

        currentBucket = bucket;
        out.push(point);
    }

    return out;
}
