import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrandAliasesRepository } from "../db/BrandAliasesRepository";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { BrandResolver } from "./brand-resolver";
import { MatchExecutor } from "./match-executor";
import { Matcher, type MatcherInput } from "./matcher";

function setup() {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-mexec-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('kosik.cz','Košík.cz','CZK',1,1,1,1,1,'none')`);
    const repo = new BrandAliasesRepository(db);
    const resolver = new BrandResolver(repo);
    const matcher = new Matcher(db, resolver);
    const executor = new MatchExecutor({ matcher, shopsDb: db });
    return { db, executor };
}

let counter = 0;
function insertPendingProduct(
    db: ShopsDatabase,
    fields: {
        ean?: string | null;
        brand?: string | null;
        brandNormalized?: string | null;
        nameNormalized: string;
        shopOrigin?: string;
    }
): number {
    counter += 1;
    const now = new Date().toISOString();
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, brand, brand_normalized, ean,
                               match_method, first_seen_at, last_updated_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)`,
        [
            fields.shopOrigin ?? "rohlik.cz",
            `slug-${counter}-${Math.random()}`,
            `https://rohlik.cz/p/${counter}`,
            fields.nameNormalized,
            fields.nameNormalized,
            fields.brand ?? null,
            fields.brandNormalized ?? null,
            fields.ean ?? null,
            now,
            now,
        ]
    );
    const row = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
    if (!row) {
        throw new Error("product insert failed");
    }
    return row.id;
}

describe("MatchExecutor.apply", () => {
    it("links and updates products + bumps total_offers on master (EAN)", async () => {
        const { db, executor } = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug,
                                          ean, total_offers, created_at, updated_at, verified_by)
             VALUES (?, ?, ?, ?, 0, ?, ?, 'auto')`,
            ["Cola 1.5L", "cola 15l", "cola-15l", "1234567890123", now, now]
        );
        const masterId = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;

        const productId = insertPendingProduct(db, { ean: "1234567890123", nameNormalized: "cola 15l" });
        const input: MatcherInput = {
            productId,
            shopOrigin: "rohlik.cz",
            name: "Cola 1.5L",
            nameNormalized: "cola 15l",
            brandRaw: null,
            brandNormalized: null,
            ean: "1234567890123",
            unit: null,
            unitAmount: null,
            packCount: null,
            flavorKey: null,
        };

        const result = await executor.apply(input);
        expect(result.kind).toBe("linked");

        const after = db
            .raw()
            .query<{ master_product_id: number; match_method: string }, [number]>(
                "SELECT master_product_id, match_method FROM products WHERE id = ?"
            )
            .get(productId);
        expect(after?.master_product_id).toBe(masterId);
        expect(after?.match_method).toBe("ean");

        const denorm = db
            .raw()
            .query<{ total_offers: number }, [number]>("SELECT total_offers FROM master_products WHERE id = ?")
            .get(masterId);
        expect(denorm?.total_offers).toBe(1);
        db.close();
    });

    it("auto-seeds when no candidate", async () => {
        const { db, executor } = setup();
        const productId = insertPendingProduct(db, {
            nameNormalized: "completely unique product xyz",
        });
        const input: MatcherInput = {
            productId,
            shopOrigin: "rohlik.cz",
            name: "Completely Unique Product XYZ",
            nameNormalized: "completely unique product xyz",
            brandRaw: null,
            brandNormalized: "uniquebrand",
            ean: null,
            unit: null,
            unitAmount: null,
            packCount: null,
            flavorKey: null,
        };

        const result = await executor.apply(input);
        expect(result.kind).toBe("seed");

        const after = db
            .raw()
            .query<{ master_product_id: number; match_method: string }, [number]>(
                "SELECT master_product_id, match_method FROM products WHERE id = ?"
            )
            .get(productId);
        expect(after?.master_product_id).not.toBeNull();
        expect(after?.match_method).toBe("auto-seed");
        db.close();
    });

    it("inserts match_candidates row on gray-zone (canonicalized a<b)", async () => {
        const { db, executor } = setup();
        const now = new Date().toISOString();
        const masterName = "xx product alpha bcdefghij";
        const inputName = "xx product alpha bcdefghxx";
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug,
                                          brand, brand_normalized, total_offers, created_at, updated_at, verified_by)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'auto')`,
            [masterName, masterName, "existing-slug", "Brand", "brand", now, now]
        );
        const masterId = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
        db.raw().run(
            `INSERT INTO products (shop_origin, slug, url, name, name_normalized, brand, brand_normalized,
                                   master_product_id, match_method, match_at, first_seen_at, last_updated_at, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'auto-seed', ?, ?, ?, 1)`,
            ["rohlik.cz", "a", "http://a", masterName, masterName, "Brand", "brand", masterId, now, now, now]
        );

        const productId = insertPendingProduct(db, {
            brand: "Brand",
            brandNormalized: "brand",
            nameNormalized: inputName,
            shopOrigin: "kosik.cz",
        });
        const input: MatcherInput = {
            productId,
            shopOrigin: "kosik.cz",
            name: inputName,
            nameNormalized: inputName,
            brandRaw: "Brand",
            brandNormalized: "brand",
            ean: null,
            unit: null,
            unitAmount: null,
            packCount: null,
            flavorKey: null,
        };

        const result = await executor.apply(input);
        expect(result.kind).toBe("gray-zone");

        const cand = db
            .raw()
            .query<{ product_id_a: number; product_id_b: number; status: string }, []>(
                "SELECT product_id_a, product_id_b, status FROM match_candidates"
            )
            .get();
        expect(cand).not.toBeNull();
        expect(cand!.product_id_a).toBeLessThan(cand!.product_id_b);
        expect(cand!.status).toBe("pending");
        db.close();
    });
});
