import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "./ShopsDatabase";

function tmpDb(): ShopsDatabase {
    const dir = mkdtempSync(join(tmpdir(), "shops-db-"));
    return new ShopsDatabase(join(dir, "test.db"));
}

describe("ShopsDatabase", () => {
    it("runs migrations on open", async () => {
        const db = tmpDb();
        const tables = db
            .raw()
            .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'`)
            .all();
        expect(tables).toHaveLength(1);
        db.close();
    });

    it("upserts a shop, master, product, and price", async () => {
        const db = tmpDb();

        await db.upsertShop({
            origin: "rohlik.cz",
            display_name: "Rohlík.cz",
            currency: "CZK",
            cap_live: 1,
            cap_history: 1,
            cap_listing: 1,
            cap_ean: 1,
            cap_search: 1,
            bot_protection: "none",
        });

        const masterId = await db.upsertMasterProduct({
            canonical_name: "Ritter Sport mléčná 100g",
            canonical_name_normalized: "ritter sport mlecna 100g",
            canonical_slug: "ritter-sport-mlecna-100g",
            brand: "Ritter Sport",
            brand_normalized: "ritter sport",
            ean: null,
            unit: "g",
            unit_amount: 100,
            pack_count: null,
            flavor_key: null,
            representative_image_url: null,
            attributes_json: "{}",
            verified_by: "auto",
        });
        expect(typeof masterId).toBe("number");

        const productId = await db.upsertProduct({
            shop_origin: "rohlik.cz",
            slug: "1419780",
            url: "https://www.rohlik.cz/1419780",
            name: "Ritter Sport mléčná čokoláda 100g",
            name_normalized: "ritter sport mlecna cokolada 100g",
            brand: "Ritter Sport",
            brand_normalized: "ritter sport",
            ean: null,
            image_url: null,
            unit: "g",
            unit_amount: 100,
            pack_count: null,
            flavor_key: null,
            master_product_id: masterId,
            match_method: "auto-seed",
            match_similarity: null,
        });
        expect(typeof productId).toBe("number");

        await db.recordPrice({
            product_id: productId,
            observed_at: "2026-05-08T10:00:00Z",
            current_price: 39.9,
            original_price: 49.9,
            in_stock: 1,
            source: "hlidac-s3",
        });

        const offers = await db.getCurrentOffersForMaster(masterId);
        expect(offers).toHaveLength(1);
        expect(offers[0]?.current_price).toBe(39.9);
        db.close();
    });

    it("upsertProduct is idempotent on (shop_origin, slug)", async () => {
        const db = tmpDb();

        await db.upsertShop({
            origin: "rohlik.cz",
            display_name: "Rohlík.cz",
            currency: "CZK",
            cap_live: 1,
            cap_history: 1,
            cap_listing: 1,
            cap_ean: 1,
            cap_search: 1,
            bot_protection: "none",
        });
        const masterId = await db.upsertMasterProduct({
            canonical_name: "Test",
            canonical_name_normalized: "test",
            canonical_slug: "test",
            attributes_json: "{}",
        });
        const id1 = await db.upsertProduct({
            shop_origin: "rohlik.cz",
            slug: "abc",
            url: "u1",
            name: "n1",
            name_normalized: "n1",
            master_product_id: masterId,
            match_method: "auto-seed",
        });
        const id2 = await db.upsertProduct({
            shop_origin: "rohlik.cz",
            slug: "abc",
            url: "u2",
            name: "n2",
            name_normalized: "n2",
            master_product_id: masterId,
            match_method: "auto-seed",
        });
        expect(id1).toBe(id2);
        const row = await db.kysely().selectFrom("products").selectAll().where("id", "=", id1).executeTakeFirst();
        expect(row?.url).toBe("u2");
        expect(row?.name).toBe("n2");
        db.close();
    });

    it("inserts http_requests rows", async () => {
        const db = tmpDb();
        await db.insertHttpRequest({
            ts: "2026-05-08T10:00:00Z",
            method: "GET",
            url: "https://example.com",
            source: "Test",
            duration_ms: 42,
            status: 200,
        });
        const count = await db
            .kysely()
            .selectFrom("http_requests")
            .select(db.kysely().fn.countAll<number>().as("c"))
            .executeTakeFirstOrThrow();
        expect(Number(count.c)).toBe(1);
        db.close();
    });
});
