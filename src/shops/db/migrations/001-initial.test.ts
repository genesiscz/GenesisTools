import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { migration001 } from "@app/shops/db/migrations/001-initial";
import { runMigrations } from "@app/utils/database/migrations";

const EXPECTED_TABLES = [
    "shops",
    "master_categories",
    "categories",
    "products",
    "product_categories",
    "master_products",
    "match_candidates",
    "prices",
    "crawl_runs",
    "favorites",
    "notifications",
    "http_requests",
    "brand_aliases",
];
const EXPECTED_VIEWS = ["current_offers"];

function names(db: Database, type: "table" | "view"): string[] {
    const rows = db
        .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type = '${type}' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'products_fts%'`
        )
        .all();
    return rows.map((r) => r.name).sort();
}

describe("migration 001-initial", () => {
    it("creates all expected tables", () => {
        const db = new Database(":memory:");
        runMigrations(db, [migration001], { tableName: "shops" });
        expect(names(db, "table").sort()).toEqual([...EXPECTED_TABLES].sort());
        db.close();
    });

    it("creates the current_offers view", () => {
        const db = new Database(":memory:");
        runMigrations(db, [migration001], { tableName: "shops" });
        expect(names(db, "view")).toEqual(EXPECTED_VIEWS);
        db.close();
    });

    it("is idempotent (second run skips)", () => {
        const db = new Database(":memory:");
        const r1 = runMigrations(db, [migration001], { tableName: "shops" });
        const r2 = runMigrations(db, [migration001], { tableName: "shops" });
        expect(r1.applied).toEqual(["001-initial"]);
        expect(r2.applied).toEqual([]);
        expect(r2.skipped).toEqual(["001-initial"]);
        db.close();
    });

    it("enforces products.match_method NOT NULL", () => {
        const db = new Database(":memory:");
        runMigrations(db, [migration001], { tableName: "shops" });
        db.exec("PRAGMA foreign_keys = ON;");
        // First insert a shop so the FK passes; we want to fail on match_method NOT NULL.
        db.run(
            `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
             VALUES ('x', 'X', 'CZK', 0, 0, 0, 0, 0, 'none')`
        );
        expect(() =>
            db.run(
                `INSERT INTO products (shop_origin, slug, url, name, name_normalized, first_seen_at, last_updated_at)
                 VALUES ('x', 's', 'u', 'n', 'n', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
            )
        ).toThrow();
        db.close();
    });

    it("allows products.master_product_id to be NULL when match_method = 'pending'", () => {
        const db = new Database(":memory:");
        runMigrations(db, [migration001], { tableName: "shops" });
        db.exec("PRAGMA foreign_keys = ON;");
        db.run(
            `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
             VALUES ('x', 'X', 'CZK', 0, 0, 0, 0, 0, 'none')`
        );
        db.run(
            `INSERT INTO products (shop_origin, slug, url, name, name_normalized, match_method, first_seen_at, last_updated_at)
             VALUES ('x', 's', 'u', 'n', 'n', 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
        );
        const row = db.query("SELECT master_product_id FROM products WHERE slug = 's'").get();
        expect(row).toEqual({ master_product_id: null });
        db.close();
    });
});
