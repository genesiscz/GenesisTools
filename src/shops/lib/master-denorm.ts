import { sql } from "kysely";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

/**
 * Refresh the cached/denormalized fields on a master_products row from its
 * linked products + current_offers. Call this whenever the set of products
 * under a master changes (link/unlink/seed/merge) or whenever a price for
 * one of those products lands.
 *
 * - `total_offers`: COUNT(active products under the master)
 * - `representative_image_url`: keep the existing curated image; otherwise
 *   inherit the first non-null product image (so /browse cards aren't blank
 *   right after auto-seed).
 * - `best_price` / `best_price_shop` / `best_price_at`: MIN(current_price)
 *   from current_offers across all products under the master, NULL when
 *   no priced offer exists.
 */
export async function refreshMasterDenorm(db: ShopsDatabase, masterId: number): Promise<void> {
    const k = db.kysely();
    const now = new Date().toISOString();

    await k
        .updateTable("master_products")
        .set((eb) => ({
            total_offers: eb
                .selectFrom("products")
                .select((eb2) => eb2.fn.countAll<number>().as("c"))
                .where("master_product_id", "=", masterId)
                .where("is_active", "=", 1),
            representative_image_url: sql<string | null>`COALESCE(
                representative_image_url,
                (SELECT image_url FROM products
                   WHERE master_product_id = ${masterId} AND is_active = 1 AND image_url IS NOT NULL
                   ORDER BY id LIMIT 1)
            )`,
            updated_at: now,
        }))
        .where("id", "=", masterId)
        .execute();

    const best = await k
        .selectFrom("current_offers")
        .select(["current_price", "shop_origin", "price_observed_at"])
        .where("master_product_id", "=", masterId)
        .where("current_price", "is not", null)
        .orderBy("current_price", "asc")
        .orderBy("price_observed_at", "desc")
        .limit(1)
        .executeTakeFirst();

    if (best && best.current_price !== null) {
        await k
            .updateTable("master_products")
            .set({
                best_price: best.current_price,
                best_price_shop: best.shop_origin,
                best_price_at: best.price_observed_at,
            })
            .where("id", "=", masterId)
            .execute();
        return;
    }

    await k
        .updateTable("master_products")
        .set({ best_price: null, best_price_shop: null, best_price_at: null })
        .where("id", "=", masterId)
        .execute();
}
