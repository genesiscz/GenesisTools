import type { Database } from "bun:sqlite";
import { autoSeriesStepMs } from "@genesiscz/utils/ai/usage/contract/step";
import { readUsageSamples, type UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import { ClaudeDatabase } from "@genesiscz/utils/claude/database";
import { runMigrations } from "@genesiscz/utils/database/migrations";
import { USAGE_LIMITS_MIGRATIONS } from "./migrations";
import {
    groupSeriesRows,
    type SeriesAgg,
    type SeriesBinEntry,
    type SeriesEntry,
    type SeriesRow,
    shapeBins,
    shapePoints,
} from "./series-rows";

export type { SeriesAgg, SeriesBin, SeriesBinEntry, SeriesEntry, SeriesPoint } from "./series-rows";

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
    /** Omitted is `limited`: a reading of a window the account has. `recordAbsentIfChanged` writes `absent`. */
    availability?: StoredAvailability;
}

/** What the `availability` column holds. NULL (a row from before the column) reads as `unknown`. */
export type StoredAvailability = "limited" | "absent";

/** Readers of utilization skip the rows that only mark a window gone: they carry no reading. */
const READING_ONLY = "availability IS NOT 'absent'";

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
    /** Omitted means every account; an EMPTY list means none of them. */
    accounts?: string[];
    /** `LimitWindow.key` values, stored in the `bucket` column. Empty means none, not all. */
    keys?: string[];
    /** Window kinds (`session`, `weekly`, ...), matched after a NULL kind took its neighbours'. Empty means none. */
    kinds?: string[];
    /** ISO timestamps. */
    from: string;
    to: string;
    /**
     * Bin width in ms. Omitted derives one from `from`..`to` so a wide range stays bounded
     * (`autoSeriesStepMs`, the one default every door shares); 0 or less asks for every row.
     */
    step?: number;
    /** How a bin is drawn. Omitted is `last`, the behaviour every caller had before the modes. */
    agg?: SeriesAgg;
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

interface SeriesSqlRow {
    provider: string | null;
    account_name: string;
    bucket: string;
    timestamp: string;
    utilization: number;
    resets_at: string | null;
    severity: string | null;
    scope_model: string | null;
    kind: string | null;
    availability: string | null;
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
 * Two vocabularies reach this store for the same fact. The raw Anthropic usage endpoint
 * answers `normal` / `warning` / `critical`; the provider-neutral `LimitWindow.severity` is
 * `ok` / `warn` / `critical` (`SEVERITY_MAP` in the anthropic-sub plugin). Both are derived
 * from the same utilization, so a row whose only difference is the spelling is not a change.
 *
 * Comparing the stored strings made every writer read every OTHER writer's spelling as new.
 * With a pre-campaign `tools claude usage` writing `warning` beside a new-code daemon writing
 * `warn`, `usage_snapshots` went from ~100 rows/hour to ~2500 on 2026-09-04 and
 * `spend_snapshots` to ~840, every pair carrying identical utilization.
 *
 * Normalising here — on the write AND on the comparison — rather than at each caller is what
 * makes the dedupe hold whichever process writes the row.
 */
const SEVERITY_ALIASES: Record<string, string> = {
    normal: "ok",
    warning: "warn",
};

export function normalizeSeverity(severity: string): string {
    return SEVERITY_ALIASES[severity] ?? severity;
}

function normalizeNullableSeverity(severity: string | null): string | null {
    if (severity === null) {
        return null;
    }

    return normalizeSeverity(severity);
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
    private readonly ownsConnection: boolean;

    constructor(dbPath?: string) {
        this.ownsConnection = Boolean(dbPath);
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
                 provider, account_id, kind, money_used_minor, money_limit_minor, money_currency, availability)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            timestamp,
            accountName,
            bucket,
            utilization,
            extras.resetsAt,
            normalizeNullableSeverity(extras.severity),
            extras.scopeModel,
            extras.provider ?? DEFAULT_LIMITS_PROVIDER,
            extras.accountId ?? null,
            extras.kind ?? null,
            extras.money?.usedMinor ?? null,
            extras.money?.limitMinor ?? null,
            extras.money?.currency ?? null,
            extras.availability ?? "limited"
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

    /**
     * The money columns as `recordSnapshotV2` writes them, compared against a stored row.
     * A credit window without a cap reports `percentUsed` 0 forever (grok's
     * `toCreditWindow`), and a proportional rise in spend and cap holds the percentage
     * steady, so dedup on utilization alone froze `getLatest`'s money at the first reading.
     */
    private moneyUnchanged(latest: UsageSnapshot, money: SnapshotV2Extras["money"]): boolean {
        return (
            latest.moneyUsedMinor === (money?.usedMinor ?? null) &&
            latest.moneyLimitMinor === (money?.limitMinor ?? null) &&
            latest.moneyCurrency === (money?.currency ?? null)
        );
    }

    recordIfChangedV2(accountName: string, bucket: string, utilization: number, extras: SnapshotV2Extras): boolean {
        // The provider the INSERT will write, not the caller's optional one: an omitted
        // provider means "any provider" to the readers, so a matching row belonging to
        // another provider used to suppress this write.
        const provider = extras.provider ?? DEFAULT_LIMITS_PROVIDER;
        const latest = this.getLatest(accountName, bucket, provider);

        if (
            latest &&
            // A window that comes back after an `absent` row is a state change even at the old value.
            this.latestAvailability(accountName, bucket, provider) !== "absent" &&
            latest.utilization === utilization &&
            normalizeNullableSeverity(latest.severity) === normalizeNullableSeverity(extras.severity) &&
            (utilization === 0 || resetsAtRoughlyEqual(latest.resetsAt, extras.resetsAt)) &&
            this.moneyUnchanged(latest, extras.money)
        ) {
            // An idle window has no reset clock worth recording. Codex reports "now + window"
            // for a 0% window, so `resetsAt` moved with every poll and each poll appended a
            // +0.0 row (17 rows/hour per untouched account, 2026-09-10). Anthropic does the
            // same in reverse: an idle window's `resets_at` flips between absent and a value.
            // Once utilization is above 0 the clock is real again and its drift counts.
            return false;
        }

        this.recordSnapshotV2(accountName, bucket, utilization, new Date().toISOString(), extras);
        return true;
    }

    /**
     * Records that the provider confirmed this window gone, once per change of state: one
     * `absent` row when the window disappears, none while it stays gone. The row's utilization is
     * 0 and means nothing; every utilization reader skips it (`READING_ONLY`).
     */
    recordAbsentIfChanged(
        accountName: string,
        bucket: string,
        extras: { provider: string; accountId?: string | null; kind: string }
    ): boolean {
        if (this.latestAvailability(accountName, bucket, extras.provider) === "absent") {
            return false;
        }

        this.recordSnapshotV2(accountName, bucket, 0, new Date().toISOString(), {
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: extras.provider,
            accountId: extras.accountId ?? null,
            kind: extras.kind,
            availability: "absent",
        });
        return true;
    }

    /** The availability of the newest row of a window, absent rows included; null when it has none or an old row. */
    private latestAvailability(accountName: string, bucket: string, provider: string): string | null {
        const row = this.claudeDb
            .getDb()
            .prepare(`
                SELECT availability FROM usage_snapshots
                WHERE account_name = ?1 AND bucket = ?2 AND provider = ?3
                ORDER BY timestamp DESC, id DESC
                LIMIT 1
            `)
            .get(accountName, bucket, provider) as { availability: string | null } | null;

        return row?.availability ?? null;
    }

    getLatest(accountName: string, bucket: string, provider?: string): UsageSnapshot | null {
        const stmt = this.claudeDb.getDb().prepare(`
            SELECT ${SNAPSHOT_COLUMNS}
            FROM usage_snapshots
            WHERE account_name = ?1 AND bucket = ?2
              AND (?3 IS NULL OR provider = ?3)
              AND ${READING_ONLY}
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
              AND ${READING_ONLY}
            ORDER BY timestamp ASC
        `);
        const rows = stmt.all(accountName, bucket, cutoff, provider ?? null) as SnapshotRow[];

        return rows.map((row) => this.mapRow(row));
    }

    /** The forecast's samples since `since`, readings only, through the one query the hub forecast also runs. */
    getForecastSamples(options: { since: Date; provider?: string; account?: string }): UsageSample[] {
        return readUsageSamples(this.claudeDb.getDb(), options);
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
     * Percent-over-time per (provider, account, window key, kind), for the charts and the
     * series door (spec 9.4, design 2026-11-01 section 6). `agg` picks how a bin is drawn:
     * `last` keeps each bin's last row, `minmax` its open, close, min and max (a reset splits a
     * bin, so a peak just before it survives), `raw` every row. Every mode reads `resets` from
     * the full rows first, so no step hides a reset.
     *
     * A caller that names no `step` gets `autoSeriesStepMs(from, to)` rather than every row:
     * a 7-day range at the 30s poll period would otherwise return 20,160 points per series.
     */
    getSeries(query: SeriesQuery & { agg: "minmax" }): SeriesBinEntry[];
    getSeries(query: SeriesQuery & { agg?: "raw" | "last" }): SeriesEntry[];
    getSeries(query: SeriesQuery): SeriesEntry[] | SeriesBinEntry[];
    getSeries(query: SeriesQuery): SeriesEntry[] | SeriesBinEntry[] {
        // An omitted list means "every one"; an EMPTY list means "none of them". The
        // dashboard's account checklist can deselect the last account, and `toggleAccount`
        // hands that on as `[]`. Read as "no filter", History then drew every account while
        // the filter bar said 0 selected and the Overview correctly showed none.
        if (query.accounts?.length === 0 || query.keys?.length === 0 || query.kinds?.length === 0) {
            return [];
        }

        const where: string[] = ["timestamp >= ?", "timestamp <= ?"];
        const params: Array<string | null> = [query.from, query.to];

        if (query.provider) {
            where.push("provider = ?");
            params.push(query.provider);
        }

        if (query.accounts) {
            where.push(`account_name IN (${query.accounts.map(() => "?").join(", ")})`);
            params.push(...query.accounts);
        }

        if (query.keys) {
            where.push(`bucket IN (${query.keys.map(() => "?").join(", ")})`);
            params.push(...query.keys);
        }

        const stmt = this.claudeDb.getDb().prepare(`
            SELECT provider, account_name, bucket, timestamp, utilization, resets_at, severity, scope_model, kind,
                   availability
            FROM usage_snapshots
            WHERE ${where.join(" AND ")}
            ORDER BY provider, account_name, bucket, timestamp ASC
        `);
        const rows = stmt.all(...params) as SeriesSqlRow[];
        // Provider belongs in the identity: an unscoped query reads every provider, and two
        // providers that happen to share an account name and a window key would otherwise
        // have their points interleaved into one line.
        const shaped: SeriesRow[] = rows.map((row) => ({
            provider: row.provider ?? DEFAULT_LIMITS_PROVIDER,
            account: row.account_name,
            key: row.bucket,
            kind: row.kind,
            scopeModel: row.scope_model,
            t: row.timestamp,
            percent: row.utilization,
            resetsAt: row.resets_at,
            severity: normalizeNullableSeverity(row.severity),
            availability: storedAvailability(row.availability),
        }));
        const kinds = query.kinds ? new Set(query.kinds) : undefined;
        const groups = groupSeriesRows(shaped).filter(
            (group) => !kinds || (group.kind !== null && kinds.has(group.kind))
        );
        const opts = {
            step: query.step ?? autoSeriesStepMs(query.from, query.to),
            roughlyEqual: resetsAtRoughlyEqual,
            to: query.to,
        };

        if (query.agg === "minmax") {
            return groups.map((group) => shapeBins(group, opts));
        }

        const agg = query.agg ?? "last";
        return groups.map((group) => shapePoints(group, agg, opts));
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
        // Same rule as `recordIfChangedV2`: compare against the provider being written.
        const latest = this.getLatestSpend(accountName, provider ?? DEFAULT_LIMITS_PROVIDER);

        if (
            latest &&
            latest.used_minor === spend.used_minor &&
            latest.used_currency === spend.used_currency &&
            latest.used_exponent === spend.used_exponent &&
            latest.percent === spend.percent &&
            normalizeSeverity(latest.severity) === normalizeSeverity(spend.severity) &&
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
            normalizeSeverity(spend.severity),
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
        if (this.ownsConnection) {
            this.claudeDb.close();
        }
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

/** The column as read: `limited`, `absent`, or null for a row written before it (or an unknown value). */
function storedAvailability(value: string | null): StoredAvailability | null {
    return value === "limited" || value === "absent" ? value : null;
}
