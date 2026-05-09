import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { comparePrices, getMaster, getProduct, listCategories, matchProduct } from "./product-api";

interface SetupIds {
    masterA: number;
    productA: number;
    productB: number;
}

function setup(): { shopsDb: ShopsDatabase; ids: SetupIds } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-prod-api-")), "test.db"));
    const now = new Date().toISOString();
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz', 'Rohlík', 'CZK', 1, 1, 1, 1, 1, 'none'),
                          ('kosik.cz', 'Košík', 'CZK', 1, 1, 1, 0, 1, 'none')`);
    db.raw().run(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
         VALUES ('Ritter Sport mléčná', 'ritter sport mlecna', 'ritter-sport-mlecna', 0, ?, ?, 'auto')`,
        [now, now]
    );
    const masterA = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;

    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, brand, master_product_id, match_method, first_seen_at, last_updated_at, is_active)
         VALUES ('rohlik.cz', '1419780', 'https://www.rohlik.cz/1419780', 'Ritter Sport', 'ritter sport', 'Ritter Sport', ?, 'fuzzy', ?, ?, 1),
                ('kosik.cz', 'p-kosik', 'https://www.kosik.cz/p-kosik', 'Ritter Sport mlecna', 'ritter sport mlecna', 'Ritter Sport', ?, 'fuzzy', ?, ?, 1)`,
        [masterA, now, now, masterA, now, now]
    );
    const productA = db
        .raw()
        .query<{ id: number }, []>("SELECT id FROM products WHERE shop_origin='rohlik.cz'")
        .get()!.id;
    const productB = db
        .raw()
        .query<{ id: number }, []>("SELECT id FROM products WHERE shop_origin='kosik.cz'")
        .get()!.id;

    db.raw().run(
        `INSERT INTO prices (product_id, observed_at, current_price, original_price, in_stock, source)
         VALUES (?, datetime('now', '-2 days'), 49.90, 59.90, 1, 'api'),
                (?, datetime('now', '-1 day'), 47.90, 59.90, 1, 'api'),
                (?, datetime('now'), 45.90, 59.90, 1, 'scrape')`,
        [productA, productA, productA]
    );
    return { shopsDb: db, ids: { masterA, productA, productB } };
}

describe("getProduct", () => {
    it("returns product by {shop, slug} with history + cross-shop matches", async () => {
        const { shopsDb } = setup();
        const result = await getProduct({ shop: "rohlik.cz", slug: "1419780" }, { shopsDb });
        expect(result.product.shop_origin).toBe("rohlik.cz");
        expect(result.product.slug).toBe("1419780");
        expect(result.product.current_price).toBe(45.9);
        expect(result.history).toHaveLength(3);
        expect(result.cross_shop_matches).toHaveLength(1);
        expect(result.cross_shop_matches[0].product.shop_origin).toBe("kosik.cz");
        shopsDb.close();
    });

    it("resolves a URL via parseItemDetails when {url} is given", async () => {
        const { shopsDb } = setup();
        const result = await getProduct({ url: "https://www.rohlik.cz/1419780-ritter-sport" }, { shopsDb });
        expect(result.product.shop_origin).toBe("rohlik.cz");
        shopsDb.close();
    });

    it("throws when {shop, slug} resolves nothing", async () => {
        const { shopsDb } = setup();
        await expect(getProduct({ shop: "rohlik.cz", slug: "doesnotexist" }, { shopsDb })).rejects.toThrow(
            /not found/i
        );
        shopsDb.close();
    });

    it("throws when input has neither url nor shop+slug", async () => {
        const { shopsDb } = setup();
        await expect(getProduct({}, { shopsDb })).rejects.toThrow(/url.*shop.*slug/i);
        shopsDb.close();
    });
});

describe("matchProduct", () => {
    it("returns cross-shop matches for the master of the URL's product", async () => {
        const { shopsDb } = setup();
        const matches = await matchProduct({ url: "https://www.rohlik.cz/1419780-ritter-sport" }, { shopsDb });
        expect(matches).toHaveLength(1);
        expect(matches[0].product.shop_origin).toBe("kosik.cz");
        shopsDb.close();
    });
});

describe("listCategories", () => {
    it("returns rows from the categories table for the given shop", async () => {
        const { shopsDb } = setup();
        shopsDb.raw().exec(
            `INSERT INTO categories (id, shop_origin, name, parent_id) VALUES
                 ('300101', 'rohlik.cz', 'Drinks', NULL),
                 ('300101001', 'rohlik.cz', 'Coffee', '300101')`
        );
        const cats = await listCategories({ shop: "rohlik.cz" }, { shopsDb });
        expect(cats).toHaveLength(2);
        expect(cats.find((c) => c.id === "300101001")?.parent_id).toBe("300101");
        shopsDb.close();
    });
});

describe("comparePrices", () => {
    it("returns offers and history-point counts for each master id", async () => {
        const { shopsDb, ids } = setup();
        const out = await comparePrices({ masterIds: [ids.masterA] }, { shopsDb });
        expect(out).toHaveLength(1);
        expect(out[0].master_id).toBe(ids.masterA);
        expect(out[0].offers.length).toBeGreaterThanOrEqual(2);
        expect(out[0].history_points).toBeGreaterThanOrEqual(3);
        shopsDb.close();
    });

    it("returns an empty offers array for an unknown master id", async () => {
        const { shopsDb } = setup();
        const out = await comparePrices({ masterIds: [9999] }, { shopsDb });
        expect(out).toHaveLength(1);
        expect(out[0].offers).toEqual([]);
        shopsDb.close();
    });
});

describe("getMaster", () => {
    it("returns canonical_name and offers for an existing master", async () => {
        const { shopsDb, ids } = setup();
        const out = await getMaster({ id: ids.masterA }, { shopsDb });
        expect(out.master_id).toBe(ids.masterA);
        expect(out.canonical_name).toBe("Ritter Sport mléčná");
        expect(out.offers.length).toBeGreaterThanOrEqual(2);
        shopsDb.close();
    });
});
