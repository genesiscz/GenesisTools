import type { Database } from "bun:sqlite";
import type { Migration } from "@genesiscz/utils/database/migrations";

function columnNames(db: Database, table: string): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
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
];
