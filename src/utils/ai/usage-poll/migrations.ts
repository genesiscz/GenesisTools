import type { Database } from "bun:sqlite";
import type { Migration } from "@genesiscz/utils/database/migrations";

function columnNames(db: Database, table: string): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
}

/**
 * Migrations for the limits store (spec 2026-09-04 section 6.2). Applied by `UsageLimitsDb`
 * on every read-write open, recorded in `_migrations` under the scope `usage_limits`.
 *
 * Registered here and nowhere else. `INDEXER_MIGRATIONS` is indexer-only.
 */
export const USAGE_LIMITS_MIGRATIONS: Migration[] = [
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
];
