import { logger } from "@app/logger";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { addFavoriteByMaster } from "@app/shops/lib/watchlist-api";
import { SafeJSON } from "@app/utils/json";

const log = logger.child({ component: "shops:order-sync-backfill" });

export interface BackfillArgs {
    userId: number;
    userProviderId: number;
}

export interface BackfillResult {
    candidates: number;
    added: number;
    already_present: number;
}

/**
 * Walk every matched item this provider has ingested (`user_order_items` with
 * `master_product_id IS NOT NULL`) and add a favorite per distinct master.
 * Idempotent: existing favorites trigger UNIQUE constraint failures which we
 * count as `already_present` and swallow.
 *
 * Used by:
 *  - `/api/providers/backfill` (manual "Sync existing → watchlist" button)
 *  - `/api/providers/update` (auto-fired when `auto_watchlist` flips 0 → 1)
 */
export async function backfillWatchlist(args: BackfillArgs): Promise<BackfillResult> {
    const db = getShopsDatabase();
    const providers = new UserProvidersRepository(db);
    const provider = await providers.getById(args.userProviderId);
    if (!provider || provider.user_id !== args.userId) {
        throw new Error("provider not found for user");
    }

    const defaults = SafeJSON.parse(provider.watchlist_defaults_json ?? "{}") as {
        drop_percent?: number;
        cooldown_hours?: number;
        notify_back_in_stock?: boolean;
    };

    const rows = await db
        .kysely()
        .selectFrom("user_order_items as uoi")
        .innerJoin("user_orders as uo", "uo.id", "uoi.order_id")
        .where("uo.user_provider_id", "=", provider.id)
        .where("uoi.master_product_id", "is not", null)
        .select("uoi.master_product_id as master_product_id")
        .distinct()
        .execute();

    const existing = await db
        .kysely()
        .selectFrom("favorites")
        .select("master_product_id")
        .where("user_id", "=", args.userId)
        .where("active", "=", 1)
        .execute();
    const existingMasters = new Set(existing.map((e) => e.master_product_id));

    let added = 0;
    let already = 0;
    for (const r of rows) {
        if (r.master_product_id === null) {
            continue;
        }

        if (existingMasters.has(r.master_product_id)) {
            already++;
            continue;
        }

        try {
            await addFavoriteByMaster(args.userId, {
                master_product_id: r.master_product_id,
                drop_percent: defaults.drop_percent ?? 0.1,
                cooldown_hours: defaults.cooldown_hours ?? 24,
                notify_back_in_stock: defaults.notify_back_in_stock ?? false,
            });
            existingMasters.add(r.master_product_id);
            added++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("UNIQUE")) {
                already++;
                continue;
            }

            throw err;
        }
    }

    log.info(
        { userId: args.userId, providerId: provider.id, candidates: rows.length, added, already },
        "backfillWatchlist done"
    );
    return { candidates: rows.length, added, already_present: already };
}
