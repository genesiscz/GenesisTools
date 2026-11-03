import type { Database } from "bun:sqlite";
import type { Migration } from "@genesiscz/utils/database/migrations";

function columnNames(db: Database, table: string): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
}

/** A `PRAGMA table_info` row: `pk` is the column's position in the primary key, 0 when it is not in it. */
interface KeyColumn {
    name: string;
    pk: number;
}

function tableExists(db: Database, table: string): boolean {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
}

/**
 * Migrations for the limits store (spec 2026-09-04 section 6.2). Applied by `UsageLimitsDb`
 * on every read-write open, recorded in `_migrations` under the scope `usage_limits`.
 *
 * Registered here and nowhere else. `INDEXER_MIGRATIONS` is indexer-only.
 */
export const USAGE_LIMITS_MIGRATIONS: Migration[] = [
    {
        /**
         * `CREATE TABLE usage_snapshots` never declared these two, so EVERY fresh
         * store needs them added. They used to be added inline by `ensureSchema`
         * with a bare PRAGMA check and no transaction, which two processes opening
         * the same fresh file both passed before either altered; the loser died on
         * `duplicate column name`. Four processes open this store, so first run on
         * a new machine is exactly when that happened.
         */
        id: "2026-05-usage-limits-severity",
        description: "severity / scope_model columns on usage_snapshots",
        isApplied(db) {
            const cols = columnNames(db, "usage_snapshots");
            return cols.has("severity") && cols.has("scope_model");
        },
        apply(db) {
            const cols = columnNames(db, "usage_snapshots");

            if (!cols.has("severity")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN severity TEXT");
            }

            if (!cols.has("scope_model")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN scope_model TEXT");
            }
        },
    },
    {
        id: "2026-09-usage-limits-provider",
        description: "provider / account_id / kind / money columns on usage_snapshots, provider on spend_snapshots",
        isApplied(db) {
            return columnNames(db, "usage_snapshots").has("provider");
        },
        apply(db) {
            const usage = columnNames(db, "usage_snapshots");

            if (!usage.has("provider")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic-sub'");
            }

            if (!usage.has("account_id")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN account_id TEXT");
            }

            if (!usage.has("kind")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN kind TEXT");
            }

            if (!usage.has("money_used_minor")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN money_used_minor INTEGER");
            }

            if (!usage.has("money_limit_minor")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN money_limit_minor INTEGER");
            }

            if (!usage.has("money_currency")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN money_currency TEXT");
            }

            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_usage_snapshots_provider_account_bucket_ts
                    ON usage_snapshots(provider, account_name, bucket, timestamp)
            `);

            if (!columnNames(db, "spend_snapshots").has("provider")) {
                db.exec("ALTER TABLE spend_snapshots ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic-sub'");
            }
        },
    },
    {
        /**
         * Whether the account had the window at that moment (design 2026-11-01, step U2):
         * `limited` for a reading, `absent` for a row that records the provider confirmed the
         * window gone (an account without a 5-hour limit). NULL is a row written before this
         * column, which every reader treats as `unknown`; nothing is backfilled.
         */
        id: "2026-11-usage-limits-availability",
        description: "availability column on usage_snapshots",
        isApplied(db) {
            return columnNames(db, "usage_snapshots").has("availability");
        },
        apply(db) {
            if (!columnNames(db, "usage_snapshots").has("availability")) {
                db.exec("ALTER TABLE usage_snapshots ADD COLUMN availability TEXT");
            }
        },
    },
    {
        /**
         * What the poller knew, as run lengths (design 2026-11-01, step U5): one row per account while its outcome
         * stays the same, so a minute tick adds no row. A span with no row is a span nobody polled (the daemon was
         * down or the Mac slept), which is what tells "idle" from "not measured".
         */
        id: "2026-11-usage-poll-runs",
        description: "usage_poll_runs table (poll coverage per account)",
        isApplied(db) {
            return tableExists(db, "usage_poll_runs");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS usage_poll_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    provider TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    account_name TEXT NOT NULL,
                    from_ts TEXT NOT NULL,
                    to_ts TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    source TEXT,
                    gate_until TEXT,
                    reason TEXT,
                    polls INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_usage_poll_runs_account
                    ON usage_poll_runs(provider, account_id, to_ts);
                CREATE INDEX IF NOT EXISTS idx_usage_poll_runs_to
                    ON usage_poll_runs(to_ts);
            `);
        },
    },
    {
        /**
         * Rate-limit answers, cooldowns, gate backoffs, refused probes and daily probe counts (step U6). They lived
         * only as day-log text before. A daily count row carries `day` and a running `count`; any other row is one
         * event with `count` 1.
         */
        id: "2026-11-usage-events",
        description: "usage_events table (rate limits, cooldowns, probes)",
        isApplied(db) {
            return tableExists(db, "usage_events");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS usage_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    account_id TEXT,
                    account_name TEXT,
                    source TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    retry_after_ms INTEGER,
                    model TEXT,
                    detail TEXT,
                    day TEXT,
                    count INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_usage_events_ts
                    ON usage_events(ts);
                CREATE INDEX IF NOT EXISTS idx_usage_events_account
                    ON usage_events(provider, account_name, kind, ts);
            `);
        },
    },
    {
        /**
         * Every alert the engine fired (step U7): the record the old threshold notifier never kept, the dedupe
         * memory of the engine, and the feed the popover and `tools ai usage alerts` read.
         */
        id: "2026-11-usage-alerts",
        description: "usage_alerts table (fired usage alerts)",
        isApplied(db) {
            return tableExists(db, "usage_alerts");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS usage_alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rule TEXT NOT NULL,
                    provider TEXT,
                    account_id TEXT,
                    account_name TEXT,
                    window_kind TEXT,
                    window_key TEXT,
                    fired_at TEXT NOT NULL,
                    dedupe_key TEXT NOT NULL,
                    cycle TEXT,
                    severity REAL NOT NULL,
                    level TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    payload TEXT,
                    channels TEXT,
                    ack_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_usage_alerts_dedupe
                    ON usage_alerts(dedupe_key, fired_at);
                CREATE INDEX IF NOT EXISTS idx_usage_alerts_fired
                    ON usage_alerts(fired_at);
            `);
        },
    },
    {
        /**
         * Each window's reset history, written by the alert engine from every reading (fired or not): the reset instant
         * last read and when a different one was last seen. An alert stored with no reset time (the provider sent none)
         * re-arms at the first reset seen after it, as the old notifier's tracker did.
         */
        id: "2026-11-usage-window-cycles",
        description: "usage_window_cycles table (the reset history of each window, for the alert engine)",
        isApplied(db) {
            return tableExists(db, "usage_window_cycles");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS usage_window_cycles (
                    provider TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    window_key TEXT NOT NULL,
                    resets_at TEXT NOT NULL,
                    reset_seen_at TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (provider, account_id, window_key)
                );
            `);
        },
    },
    {
        /**
         * Where the daemon's alert pass got to: the instant of the last pass that finished. Events after it are the next
         * pass's, so a pass that failed (or a process killed mid-pass) leaves its events to the pass after it. It is
         * apart from `usage_poll_runs`, which records the polls whether or not alerts were judged.
         */
        id: "2026-11-usage-alert-cursor",
        description: "usage_alert_cursor table (the last finished alert pass)",
        isApplied(db) {
            return tableExists(db, "usage_alert_cursor");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS usage_alert_cursor (
                    name TEXT PRIMARY KEY,
                    evaluated_at TEXT NOT NULL
                );
            `);
        },
    },
    {
        /**
         * One row per account, window and local day (step U10, proposal 16): the day's first, last and highest reading,
         * its resets, how many cycles reached 90 %, and the minutes the poller measured. It outlives the 30-day prune
         * of `usage_snapshots`, so trends past a month stay readable; the prune never touches it.
         */
        id: "2026-11-usage-daily",
        description: "usage_daily table (daily rollup per account and window)",
        isApplied(db) {
            return tableExists(db, "usage_daily");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS usage_daily (
                    provider TEXT NOT NULL,
                    account_id TEXT,
                    account_name TEXT NOT NULL,
                    bucket TEXT NOT NULL,
                    kind TEXT,
                    day TEXT NOT NULL,
                    tz TEXT NOT NULL,
                    start_pct REAL NOT NULL,
                    end_pct REAL NOT NULL,
                    peak_pct REAL NOT NULL,
                    resets INTEGER NOT NULL,
                    cycles_over_90 INTEGER NOT NULL,
                    readings INTEGER NOT NULL,
                    minutes_measured INTEGER,
                    availability TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (provider, account_name, bucket, day)
                );
                CREATE INDEX IF NOT EXISTS idx_usage_daily_day
                    ON usage_daily(day);
            `);
        },
    },
    {
        /**
         * What 1 % of a window buys, per account, model and ISO week (step U12, proposal 13): tokens and dollars per
         * percentage point with a 95 % bootstrap interval from exclusive windows, or `insufficient` with the count.
         */
        id: "2026-11-limit-drift",
        description: "limit_drift table (tokens and dollars per percent, per week)",
        isApplied(db) {
            return tableExists(db, "limit_drift");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS limit_drift (
                    provider TEXT NOT NULL,
                    account_id TEXT,
                    account_name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    model TEXT NOT NULL,
                    week TEXT NOT NULL,
                    windows INTEGER NOT NULL,
                    tokens_per_pct REAL,
                    usd_per_pct REAL,
                    ci_low REAL,
                    ci_high REAL,
                    status TEXT NOT NULL,
                    computed_at TEXT NOT NULL,
                    PRIMARY KEY (provider, account_name, kind, model, week)
                );
            `);
        },
    },
    {
        /**
         * The kind joins the daily rollup's identity: a Codex `primary` slot can pass from the session window to the
         * weekly one within a day (a plan change), and under the old key the second series overwrote the first. A
         * missing kind is stored as '' (SQLite treats NULLs in a key as distinct, so a NULL row would never conflict);
         * the store reads '' back as null. SQLite cannot change a primary key in place, so the table is rebuilt with
         * every row kept.
         */
        id: "2026-11-usage-daily-kind",
        description: "usage_daily keyed by kind as well (one row per account, window, kind and day)",
        isApplied(db) {
            const cols = db.prepare<KeyColumn, []>("PRAGMA table_info(usage_daily)").all();
            return cols.some((col) => col.name === "kind" && col.pk > 0);
        },
        apply(db) {
            db.exec(`
                CREATE TABLE usage_daily_by_kind (
                    provider TEXT NOT NULL,
                    account_id TEXT,
                    account_name TEXT NOT NULL,
                    bucket TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT '',
                    day TEXT NOT NULL,
                    tz TEXT NOT NULL,
                    start_pct REAL NOT NULL,
                    end_pct REAL NOT NULL,
                    peak_pct REAL NOT NULL,
                    resets INTEGER NOT NULL,
                    cycles_over_90 INTEGER NOT NULL,
                    readings INTEGER NOT NULL,
                    minutes_measured INTEGER,
                    availability TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (provider, account_name, bucket, kind, day)
                );
            `);

            if (tableExists(db, "usage_daily")) {
                db.exec(`
                    INSERT INTO usage_daily_by_kind
                        (provider, account_id, account_name, bucket, kind, day, tz, start_pct, end_pct, peak_pct,
                         resets, cycles_over_90, readings, minutes_measured, availability, updated_at)
                    SELECT provider, account_id, account_name, bucket, COALESCE(kind, ''), day, tz, start_pct, end_pct,
                           peak_pct, resets, cycles_over_90, readings, minutes_measured, availability, updated_at
                    FROM usage_daily;
                    DROP TABLE usage_daily;
                `);
            }

            db.exec(`
                ALTER TABLE usage_daily_by_kind RENAME TO usage_daily;
                CREATE INDEX IF NOT EXISTS idx_usage_daily_day
                    ON usage_daily(day);
            `);
        },
    },
    {
        /**
         * A drift row names its window's model scope. An unscoped weekly window and a model-scoped one of the same
         * account share kind, model and week, so under the first key the later write overwrote the other. SQLite
         * cannot change a primary key in place, so the table is rebuilt; the rows written before carry over as
         * unscoped (`''`, never NULL, which a primary key would let repeat).
         */
        id: "2026-11-limit-drift-scope",
        description: "scope_model in the limit_drift key",
        isApplied(db) {
            return columnNames(db, "limit_drift").has("scope_model");
        },
        apply(db) {
            db.exec(`
                CREATE TABLE limit_drift_scoped (
                    provider TEXT NOT NULL,
                    account_id TEXT,
                    account_name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    scope_model TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL,
                    week TEXT NOT NULL,
                    windows INTEGER NOT NULL,
                    tokens_per_pct REAL,
                    usd_per_pct REAL,
                    ci_low REAL,
                    ci_high REAL,
                    status TEXT NOT NULL,
                    computed_at TEXT NOT NULL,
                    PRIMARY KEY (provider, account_name, kind, scope_model, model, week)
                );
                INSERT INTO limit_drift_scoped
                    (provider, account_id, account_name, kind, model, week, windows, tokens_per_pct, usd_per_pct,
                     ci_low, ci_high, status, computed_at)
                SELECT provider, account_id, account_name, kind, model, week, windows, tokens_per_pct, usd_per_pct,
                       ci_low, ci_high, status, computed_at
                FROM limit_drift;
                DROP TABLE limit_drift;
                ALTER TABLE limit_drift_scoped RENAME TO limit_drift;
            `);
        },
    },
];
