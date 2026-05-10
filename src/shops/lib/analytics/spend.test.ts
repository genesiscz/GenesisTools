import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import {
    monthlySpend,
    spendByCategory,
    spendByShop,
    topProducts,
} from "@app/shops/lib/analytics/spend";

function fixture(): { db: ShopsDatabase; userId: number } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-spend-")), "test.db"));
    const r = db.raw();
    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('kosik.cz','Košík.cz','CZK',1,1,1,1,1,'none')`);
    r.exec(`INSERT INTO master_categories (id, name, slug) VALUES (1, 'Beverages', 'beverages')`);
    r.exec(`INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, master_category_id, created_at, updated_at)
            VALUES (10, 'Cola 0.5l', 'cola 0 5l', 'cola-0-5l', 1, datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, master_category_id, created_at, updated_at)
            VALUES (11, 'Bread', 'bread', 'bread', NULL, datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO user_providers (id, user_id, shop_origin, status, created_at, updated_at)
            VALUES (1, 1, 'rohlik.cz', 'connected', datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO user_providers (id, user_id, shop_origin, status, created_at, updated_at)
            VALUES (2, 1, 'kosik.cz', 'connected', datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO user_orders (id, user_provider_id, external_order_id, ordered_at, total_amount, currency, items_count, ingested_at)
            VALUES (100, 1, 'R-1', '2026-04-12T10:00:00Z', 250, 'CZK', 2, datetime('now')),
                   (101, 1, 'R-2', '2026-05-03T10:00:00Z', 180, 'CZK', 1, datetime('now')),
                   (102, 2, 'K-1', '2026-05-08T10:00:00Z',  90, 'CZK', 1, datetime('now'))`);
    r.exec(`INSERT INTO user_order_items (order_id, line_no, name, quantity, unit_price, total_price, master_product_id)
            VALUES (100, 1, 'Cola 0.5l', 4, 25, 100, 10),
                   (100, 2, 'Bread',     2, 75, 150, 11),
                   (101, 1, 'Cola 0.5l', 6, 30, 180, 10),
                   (102, 1, 'Cola 0.5l', 3, 30,  90, 10)`);
    return { db, userId: 1 };
}

describe("monthlySpend", () => {
    it("groups totals by YYYY-MM", async () => {
        const { db, userId } = fixture();
        const rows = await monthlySpend(db, userId);
        expect(rows).toEqual([
            { month: "2026-04", total: 250, currency: "CZK", orders: 1 },
            { month: "2026-05", total: 270, currency: "CZK", orders: 2 },
        ]);
        db.close();
    });

    it("respects opts.months window", async () => {
        const { db, userId } = fixture();
        const rows = await monthlySpend(db, userId, { months: 1 });
        expect(rows.map((r) => r.month)).toEqual(["2026-05"]);
        db.close();
    });
});

describe("spendByShop", () => {
    it("totals per shop_origin", async () => {
        const { db, userId } = fixture();
        const rows = await spendByShop(db, userId);
        const byShop = Object.fromEntries(rows.map((r) => [r.shop_origin, r.total]));
        expect(byShop["rohlik.cz"]).toBe(430);
        expect(byShop["kosik.cz"]).toBe(90);
        db.close();
    });
});

describe("spendByCategory", () => {
    it("groups by master_category name; null category bucketed as 'Uncategorized'", async () => {
        const { db, userId } = fixture();
        const rows = await spendByCategory(db, userId);
        const byCat = Object.fromEntries(rows.map((r) => [r.category_path ?? "Uncategorized", r.total]));
        expect(byCat.Beverages).toBe(370);
        expect(byCat.Uncategorized).toBe(150);
        db.close();
    });
});

describe("topProducts", () => {
    it("ranks by spend_total desc with units summed", async () => {
        const { db, userId } = fixture();
        const rows = await topProducts(db, userId, { limit: 5 });
        expect(rows[0].master_product_id).toBe(10);
        expect(rows[0].units_total).toBe(13);
        expect(rows[0].spend_total).toBe(370);
        expect(rows[1].master_product_id).toBe(11);
        db.close();
    });
});
