import type { Migration } from "@app/utils/database/migrations";

/**
 * Add per-offer description fields so /master/$id can render the rich detail
 * (description, category path, raw shop tags) each ShopClient already pulls
 * from its listing API. Both products and master_products gain a nullable
 * `description` column (master inherits from its representative product when
 * none is curated).
 */
export const migration002: Migration = {
    id: "002-descriptions",
    description: "Add description + category_path columns to products and master_products",
    apply(db) {
        db.exec(`
            ALTER TABLE products ADD COLUMN description TEXT;
            ALTER TABLE products ADD COLUMN category_path TEXT;
            ALTER TABLE master_products ADD COLUMN description TEXT;
        `);
    },
};
