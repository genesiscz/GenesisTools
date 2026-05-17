import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { bestShop, bestWeekday } from "@app/shops/lib/analytics/best-time";

function fixture(): ShopsDatabase {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-bt-")), "test.db"));
    const r = db.raw();
    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('kosik.cz','Košík.cz','CZK',1,1,1,1,1,'none')`);
    r.exec(`INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
            VALUES (10, 'X', 'x', 'x', datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO products (id, shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at)
            VALUES (1, 'rohlik.cz', 'x', 'http://r/x', 'X', 'x', 10, 'auto-seed', datetime('now'), datetime('now')),
                   (2, 'kosik.cz',  'x', 'http://k/x', 'X', 'x', 10, 'auto-seed', datetime('now'), datetime('now'))`);
    // Mondays cheap on rohlik (15), Thursdays expensive (25)
    // Iso "2026-04-06" is Monday, "2026-04-09" is Thursday
    r.exec(`INSERT INTO prices (product_id, observed_at, current_price, source) VALUES
            (1, '2026-04-06T10:00:00Z', 15, 'test'),
            (1, '2026-04-13T10:00:00Z', 14, 'test'),
            (1, '2026-04-20T10:00:00Z', 16, 'test'),
            (1, '2026-04-09T10:00:00Z', 25, 'test'),
            (1, '2026-04-16T10:00:00Z', 26, 'test'),
            (2, '2026-04-06T10:00:00Z', 30, 'test'),
            (2, '2026-04-13T10:00:00Z', 31, 'test')`);
    return db;
}

describe("bestWeekday", () => {
    it("returns the weekday with the lowest avg price for a master", async () => {
        const db = fixture();
        const result = await bestWeekday(db, 10);
        expect(result).not.toBeNull();
        expect(result?.weekday).toBe(1); // Monday
        expect(result?.weekday_name).toBe("Monday");
        expect(result?.avg_price).toBeLessThan(25);
        expect(result?.sample_size).toBeGreaterThanOrEqual(3);
        db.close();
    });

    it("returns null when there's no price history for the master", async () => {
        const db = fixture();
        const result = await bestWeekday(db, 9999);
        expect(result).toBeNull();
        db.close();
    });
});

describe("bestShop", () => {
    it("returns the shop with the lowest current_price across current_offers", async () => {
        const db = fixture();
        const result = await bestShop(db, 10);
        expect(result?.shop_origin).toBe("rohlik.cz");
        expect(result?.current_price).toBeLessThan(20);
        db.close();
    });
});
