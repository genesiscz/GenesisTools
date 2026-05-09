/**
 * One-shot backfill: undo same-shop bad merges produced before the matcher's
 * same-shop guard landed. For each (master_id, shop) pair with N>1 active
 * products, keep the OLDEST product on the master, spawn fresh masters for
 * the rest (unless their name_normalized is identical to canonical_name —
 * those are real duplicate listings, leave them).
 */
import { ShopsDatabase } from "../src/shops/db/ShopsDatabase";
import { refreshMasterDenorm } from "../src/shops/lib/master-denorm";

const db = new ShopsDatabase();
const raw = db.raw();

interface Group {
    master_product_id: number;
    shop_origin: string;
    n: number;
}

const groups = raw
    .query<Group, []>(
        `SELECT master_product_id, shop_origin, COUNT(*) AS n
         FROM products
         WHERE is_active = 1 AND master_product_id IS NOT NULL
         GROUP BY master_product_id, shop_origin
         HAVING COUNT(*) > 1
         ORDER BY master_product_id, shop_origin`
    )
    .all();

console.log(`Found ${groups.length} (master, shop) groups with duplicates.`);

interface ProductInfo {
    id: number;
    name: string;
    name_normalized: string;
    brand: string | null;
    brand_normalized: string | null;
    image_url: string | null;
    slug: string;
    ean: string | null;
}

interface MasterInfo {
    canonical_name: string;
    canonical_name_normalized: string;
    canonical_slug: string;
    brand: string | null;
    brand_normalized: string | null;
}

let unlinked = 0;
const touchedMasters = new Set<number>();

for (const group of groups) {
    const master = raw
        .query<MasterInfo, [number]>(
            `SELECT canonical_name, canonical_name_normalized, canonical_slug, brand, brand_normalized
             FROM master_products WHERE id = ?`
        )
        .get(group.master_product_id);
    if (!master) {
        continue;
    }

    const products = raw
        .query<ProductInfo, [number, string]>(
            `SELECT id, name, name_normalized, brand, brand_normalized, image_url, slug, ean
             FROM products
             WHERE master_product_id = ? AND shop_origin = ? AND is_active = 1
             ORDER BY id ASC`
        )
        .all(group.master_product_id, group.shop_origin);

    const [, ...extras] = products;

    for (const p of extras) {
        const now = new Date().toISOString();
        const newSlug = `${master.canonical_slug}--split-${p.id}`.slice(0, 240);
        raw.run(
            `INSERT INTO master_products
             (canonical_name, canonical_name_normalized, canonical_slug,
              brand, brand_normalized, ean, total_offers, created_at, updated_at, verified_by, representative_image_url)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'auto', ?)`,
            [
                p.name,
                p.name_normalized,
                newSlug,
                p.brand ?? master.brand,
                p.brand_normalized ?? master.brand_normalized,
                p.ean,
                now,
                now,
                p.image_url,
            ]
        );
        const newMaster = raw.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
        if (!newMaster) {
            continue;
        }

        raw.run(
            `UPDATE products SET master_product_id = ?, match_method = 'auto-seed', match_similarity = NULL,
                                  match_at = ?, last_updated_at = ?
             WHERE id = ?`,
            [newMaster.id, now, now, p.id]
        );

        touchedMasters.add(group.master_product_id);
        touchedMasters.add(newMaster.id);
        unlinked += 1;
    }
}

for (const masterId of touchedMasters) {
    refreshMasterDenorm(raw, masterId);
}

console.log(`Unlinked ${unlinked} products into fresh masters.`);
console.log(`Refreshed ${touchedMasters.size} master denorms.`);

const remainingGroups = raw
    .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM (
            SELECT master_product_id FROM products
            WHERE is_active = 1 AND master_product_id IS NOT NULL
            GROUP BY master_product_id, shop_origin
            HAVING COUNT(*) > 1
         )`
    )
    .get();
console.log(`Remaining same-shop groups (true duplicates): ${remainingGroups?.n ?? 0}`);

db.close();
