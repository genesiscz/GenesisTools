import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { getCoverage } from "@app/shops/lib/coverage-api";

function setup(): ShopsDatabase {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-cov-api-")), "test.db"));
    const now = new Date().toISOString();
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection, enabled)
                   VALUES ('rohlik.cz', 'Rohlík', 'CZK', 1, 1, 1, 1, 1, 'none', 1),
                          ('kosik.cz', 'Košík', 'CZK', 1, 1, 1, 0, 1, 'none', 1),
                          ('itesco.cz', 'Tesco', 'CZK', 0, 1, 0, 0, 0, 'akamai', 0)`);
    db.raw().run(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
         VALUES ('A', 'a', 'a', 0, ?, ?, 'auto'), ('B', 'b', 'b', 0, ?, ?, 'auto')`,
        [now, now, now, now]
    );
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at, is_active)
         VALUES ('rohlik.cz', 'a', 'http://a', 'A', 'a', 1, 'fuzzy', ?, datetime('now', '-1 hour'), 1),
                ('rohlik.cz', 'b', 'http://b', 'B', 'b', 2, 'fuzzy', ?, ?, 1),
                ('kosik.cz', 'c', 'http://c', 'C', 'c', 1, 'fuzzy', ?, datetime('now', '-3 hours'), 1)`,
        [now, now, now, now]
    );
    return db;
}

describe("getCoverage", () => {
    it("returns one row per shop with product_count", async () => {
        const db = setup();
        const out = await getCoverage({ shopsDb: db });
        expect(out).toHaveLength(3);
        expect(out.find((s) => s.shop_origin === "rohlik.cz")?.product_count).toBe(2);
        expect(out.find((s) => s.shop_origin === "kosik.cz")?.product_count).toBe(1);
        expect(out.find((s) => s.shop_origin === "itesco.cz")?.product_count).toBe(0);
        db.close();
    });

    it("includes capability flags + bot_protection", async () => {
        const db = setup();
        const out = await getCoverage({ shopsDb: db });
        const tesco = out.find((s) => s.shop_origin === "itesco.cz");
        expect(tesco?.enabled).toBe(false);
        expect(tesco?.bot_protection).toBe("akamai");
        expect(tesco?.capabilities.live).toBe(false);
        expect(tesco?.capabilities.history).toBe(true);
        db.close();
    });

    it("returns the most recent last_updated_at per shop", async () => {
        const db = setup();
        const out = await getCoverage({ shopsDb: db });
        const rohlik = out.find((s) => s.shop_origin === "rohlik.cz");
        expect(rohlik?.last_product_update).not.toBeNull();
        db.close();
    });

    it("crawl-run timestamps are null when crawl_runs has no rows", async () => {
        const db = setup();
        const out = await getCoverage({ shopsDb: db });
        for (const row of out) {
            expect(row.last_crawl_success).toBeNull();
            expect(row.last_crawl_failure).toBeNull();
        }
        db.close();
    });

    it("populates last_crawl_success and last_crawl_failure when crawl_runs has rows", async () => {
        const db = setup();
        db.raw().run(
            `INSERT INTO crawl_runs (shop_origin, strategy, started_at, finished_at, status)
             VALUES ('rohlik.cz', 'test', datetime('now', '-1 hour'), datetime('now'), 'completed'),
                    ('rohlik.cz', 'test', datetime('now', '-3 hours'), datetime('now', '-2 hours'), 'failed')`
        );
        const out = await getCoverage({ shopsDb: db });
        const rohlik = out.find((s) => s.shop_origin === "rohlik.cz");
        expect(rohlik?.last_crawl_success).not.toBeNull();
        expect(rohlik?.last_crawl_failure).not.toBeNull();
        db.close();
    });
});
