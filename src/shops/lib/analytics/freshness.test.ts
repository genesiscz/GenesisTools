import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { freshnessFor } from "@app/shops/lib/analytics/freshness";

function fixture(): ShopsDatabase {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-fresh-")), "test.db"));
    const r = db.raw();
    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('kosik.cz','Košík.cz','CZK',1,1,1,1,1,'none')`);
    r.exec(`INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
            VALUES (10, 'X', 'x', 'x', datetime('now'), datetime('now')),
                   (11, 'Y', 'y', 'y', datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO products (id, shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at)
            VALUES (1, 'rohlik.cz', 'x', 'r/x', 'X', 'x', 10, 'auto-seed', datetime('now'), datetime('now')),
                   (2, 'kosik.cz',  'x', 'k/x', 'X', 'x', 10, 'auto-seed', datetime('now'), datetime('now')),
                   (3, 'rohlik.cz', 'y', 'r/y', 'Y', 'y', 11, 'auto-seed', datetime('now'), datetime('now'))`);
    r.exec(`INSERT INTO prices (product_id, observed_at, current_price, source)
            VALUES (1, '2026-05-09T10:00:00Z', 15, 'test'),
                   (2, '2026-05-08T10:00:00Z', 16, 'test')`);
    return db;
}

describe("freshnessFor", () => {
    it("returns last_observed_at + shops_covered for each requested master", async () => {
        const db = fixture();
        const result = await freshnessFor(db, [10, 11]);
        expect(result.get(10)?.shops_covered).toBe(2);
        expect(result.get(10)?.last_observed_at).toBe("2026-05-09T10:00:00Z");
        expect(result.get(11)?.shops_covered).toBe(0);
        expect(result.get(11)?.last_observed_at).toBeNull();
        db.close();
    });

    it("returns empty map when ids is empty", async () => {
        const db = fixture();
        const result = await freshnessFor(db, []);
        expect(result.size).toBe(0);
        db.close();
    });
});
