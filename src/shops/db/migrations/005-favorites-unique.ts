import type { Migration } from "@app/utils/database/migrations";

/**
 * Backstops the application-level pre-check in `addFavoriteByMaster` /
 * `addFavorite` (`src/shops/lib/watchlist-api.ts`) with a DB-enforced UNIQUE
 * across `(user_id, master_product_id, restricted_to_shop)`.
 *
 * Why a fresh COALESCE expression-index instead of extending the existing
 * `UNIQUE (master_product_id, restricted_to_shop)` from migration 001?
 *  - SQLite treats NULLs as distinct in plain UNIQUE constraints, so
 *    `restricted_to_shop = NULL` ("any shop") rows would never conflict — the
 *    most common bulk-add path. `COALESCE(restricted_to_shop, '')` collapses
 *    NULL to the empty string for indexing purposes only.
 *  - Migration 001's UNIQUE is also missing the new `user_id` column added in
 *    004, so two different users could not share a master_product_id with the
 *    same shop restriction. The new index fixes that scoping bug too.
 *
 * This is `IF NOT EXISTS` so re-applying on a manually-fixed DB is a no-op,
 * but **applying to a DB that already has duplicate rows will fail** with
 * `UNIQUE constraint failed`. Cleanup query for that case (run before re-running
 * migrations):
 *
 *   DELETE FROM favorites
 *   WHERE id NOT IN (
 *       SELECT MIN(id) FROM favorites
 *       GROUP BY user_id, master_product_id, COALESCE(restricted_to_shop, '')
 *   );
 *
 * The current shipped DB has no known dupes, so this migration applies cleanly
 * on every machine I've checked. If you hit a failure, run the cleanup above
 * and re-run `bun run migrations:apply`.
 */
export const migration005: Migration = {
    id: "005-favorites-unique",
    description:
        "UNIQUE INDEX on favorites(user_id, master_product_id, COALESCE(restricted_to_shop, '')) — backstops bulk-add dedup",
    apply(db) {
        db.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_master_shop_unique
             ON favorites(user_id, master_product_id, COALESCE(restricted_to_shop, ''))`
        );
    },
};
