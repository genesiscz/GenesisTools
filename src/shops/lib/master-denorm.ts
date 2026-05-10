import type { Database } from "bun:sqlite";

interface BestOfferRow {
    current_price: number;
    shop_origin: string;
    price_observed_at: string;
}

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
export function refreshMasterDenorm(db: Database, masterId: number): void {
    const now = new Date().toISOString();

    db.run(
        `UPDATE master_products SET
            total_offers = (
                SELECT COUNT(*) FROM products WHERE master_product_id = ? AND is_active = 1
            ),
            representative_image_url = COALESCE(
                representative_image_url,
                (SELECT image_url FROM products
                   WHERE master_product_id = ? AND is_active = 1 AND image_url IS NOT NULL
                   ORDER BY id LIMIT 1)
            ),
            updated_at = ?
         WHERE id = ?`,
        [masterId, masterId, now, masterId]
    );

    const best = db
        .query<BestOfferRow, [number]>(
            `SELECT current_price, shop_origin, price_observed_at
             FROM current_offers
             WHERE master_product_id = ? AND current_price IS NOT NULL
             ORDER BY current_price ASC, price_observed_at DESC
             LIMIT 1`
        )
        .get(masterId);

    if (best) {
        db.run("UPDATE master_products SET best_price = ?, best_price_shop = ?, best_price_at = ? WHERE id = ?", [
            best.current_price,
            best.shop_origin,
            best.price_observed_at,
            masterId,
        ]);
        return;
    }

    db.run("UPDATE master_products SET best_price = NULL, best_price_shop = NULL, best_price_at = NULL WHERE id = ?", [
        masterId,
    ]);
}
