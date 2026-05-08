import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { searchProducts } from "./search-api";

function setup(): ShopsDatabase {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-search-api-")), "test.db"));
    const now = new Date().toISOString();
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz', 'Rohlík', 'CZK', 1, 1, 1, 1, 1, 'none'),
                          ('kosik.cz', 'Košík', 'CZK', 1, 1, 1, 0, 1, 'none')`);
    db.raw().run(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
         VALUES ('Ritter Sport', 'ritter sport', 'ritter-sport', 0, ?, ?, 'auto'),
                ('Nescafé Gold', 'nescafe gold', 'nescafe-gold', 0, ?, ?, 'auto'),
                ('Lindt Excellence', 'lindt excellence', 'lindt-excellence', 0, ?, ?, 'auto')`,
        [now, now, now, now, now, now]
    );
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, brand, brand_normalized, master_product_id, match_method, first_seen_at, last_updated_at, is_active)
         VALUES ('rohlik.cz', 'rs1', 'http://rs1', 'Ritter Sport mléčná', 'ritter sport mlecna', 'Ritter Sport', 'ritter sport', 1, 'fuzzy', ?, ?, 1),
                ('kosik.cz', 'rs2', 'http://rs2', 'Ritter Sport hořká', 'ritter sport horka', 'Ritter Sport', 'ritter sport', 1, 'fuzzy', ?, ?, 1),
                ('rohlik.cz', 'ng1', 'http://ng1', 'Nescafé Gold 200g', 'nescafe gold 200g', 'Nescafé', 'nescafe', 2, 'fuzzy', ?, ?, 1),
                ('rohlik.cz', 'lin1', 'http://lin1', 'Lindt Excellence 70%', 'lindt excellence 70', 'Lindt', 'lindt', 3, 'fuzzy', ?, ?, 1)`,
        [now, now, now, now, now, now, now, now]
    );
    return db;
}

describe("searchProducts", () => {
    it("returns products matching the query", async () => {
        const db = setup();
        const out = await searchProducts({ query: "ritter" }, { shopsDb: db });
        expect(out.length).toBeGreaterThanOrEqual(2);
        expect(out.every((p) => p.name.includes("Ritter"))).toBe(true);
        db.close();
    });

    it("matches accent-insensitively (Nescafe ↔ Nescafé)", async () => {
        const db = setup();
        const out = await searchProducts({ query: "nescafe" }, { shopsDb: db });
        expect(out.length).toBeGreaterThanOrEqual(1);
        expect(out[0].name).toMatch(/Nescafé/);
        db.close();
    });

    it("filters by shop", async () => {
        const db = setup();
        const out = await searchProducts({ query: "ritter", shop: "kosik.cz" }, { shopsDb: db });
        expect(out).toHaveLength(1);
        expect(out[0].shop_origin).toBe("kosik.cz");
        db.close();
    });

    it("respects the limit option", async () => {
        const db = setup();
        const out = await searchProducts({ query: "ritter", limit: 1 }, { shopsDb: db });
        expect(out).toHaveLength(1);
        db.close();
    });

    it("returns empty array when query yields no matches", async () => {
        const db = setup();
        const out = await searchProducts({ query: "doesnotexist" }, { shopsDb: db });
        expect(out).toEqual([]);
        db.close();
    });

    it("rejects empty queries", async () => {
        const db = setup();
        await expect(searchProducts({ query: "" }, { shopsDb: db })).rejects.toThrow(/non-empty/i);
        await expect(searchProducts({ query: "   " }, { shopsDb: db })).rejects.toThrow(/non-empty/i);
        db.close();
    });
});
