import type { Migration } from "@genesiscz/utils/database/migrations";

export const migration006: Migration = {
    id: "006-watchlist-stock-state",
    description: "Persist the last scoped stock observation for each favorite",
    apply(db) {
        db.run("ALTER TABLE favorites ADD COLUMN last_stock_product_id INTEGER");
        db.run("ALTER TABLE favorites ADD COLUMN last_stock_shop_origin TEXT");
        db.run(
            "ALTER TABLE favorites ADD COLUMN last_stock_state INTEGER CHECK (last_stock_state IS NULL OR last_stock_state IN (0, 1))"
        );
        db.run("ALTER TABLE favorites ADD COLUMN last_stock_observed_at TEXT");
    },
};
