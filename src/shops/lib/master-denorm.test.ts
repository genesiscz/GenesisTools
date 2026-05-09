import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { refreshMasterDenorm } from "./master-denorm";

let db: ShopsDatabase;

beforeEach(() => {
    db = buildTestDatabase();
    db.raw().exec(
        `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
         VALUES ('rohlik.cz','Rohlík','CZK',1,1,1,1,1,'none')`
    );
    db.raw().exec(
        `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
         VALUES ('kosik.cz','Košík','CZK',1,1,1,1,1,'none')`
    );
});

afterEach(() => {
    db.close();
});

interface MasterRow {
    total_offers: number;
    representative_image_url: string | null;
    best_price: number | null;
    best_price_shop: string | null;
    best_price_at: string | null;
}

function readMaster(masterId: number): MasterRow {
    const row = db
        .raw()
        .query<MasterRow, [number]>(
            `SELECT total_offers, representative_image_url, best_price, best_price_shop, best_price_at
             FROM master_products WHERE id = ?`
        )
        .get(masterId);
    if (!row) {
        throw new Error("master not found");
    }

    return row;
}

function seedMaster(): number {
    const now = new Date().toISOString();
    db.raw().run(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug,
                                      total_offers, created_at, updated_at, verified_by)
         VALUES (?, ?, ?, 0, ?, ?, 'auto')`,
        ["Test", "test", `test-${Math.random()}`, now, now]
    );
    return db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id ?? 0;
}

function seedProduct(opts: { masterId: number; shop: string; price: number | null; imageUrl?: string | null }): number {
    const now = new Date().toISOString();
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id,
                               match_method, first_seen_at, last_updated_at, is_active, image_url)
         VALUES (?, ?, ?, ?, ?, ?, 'auto-seed', ?, ?, 1, ?)`,
        [
            opts.shop,
            `slug-${Math.random()}`,
            `https://${opts.shop}/x`,
            "Test",
            "test",
            opts.masterId,
            now,
            now,
            opts.imageUrl ?? null,
        ]
    );
    const productId = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()?.id ?? 0;
    if (opts.price !== null) {
        db.raw().run(
            `INSERT INTO prices (product_id, observed_at, current_price, source)
             VALUES (?, ?, ?, 'test')`,
            [productId, now, opts.price]
        );
    }

    return productId;
}

describe("refreshMasterDenorm", () => {
    it("updates total_offers from active products", () => {
        const masterId = seedMaster();
        seedProduct({ masterId, shop: "rohlik.cz", price: 50 });
        seedProduct({ masterId, shop: "kosik.cz", price: 60 });

        refreshMasterDenorm(db.raw(), masterId);

        expect(readMaster(masterId).total_offers).toBe(2);
    });

    it("sets best_price to MIN(current_price) and records best_price_shop", () => {
        const masterId = seedMaster();
        seedProduct({ masterId, shop: "rohlik.cz", price: 79.9 });
        seedProduct({ masterId, shop: "kosik.cz", price: 49.5 });

        refreshMasterDenorm(db.raw(), masterId);

        const row = readMaster(masterId);
        expect(row.best_price).toBe(49.5);
        expect(row.best_price_shop).toBe("kosik.cz");
        expect(row.best_price_at).not.toBeNull();
    });

    it("clears best_price when no current offers carry a price", () => {
        const masterId = seedMaster();
        seedProduct({ masterId, shop: "rohlik.cz", price: null });

        refreshMasterDenorm(db.raw(), masterId);

        const row = readMaster(masterId);
        expect(row.best_price).toBeNull();
        expect(row.best_price_shop).toBeNull();
        expect(row.best_price_at).toBeNull();
    });

    it("inherits representative_image_url from first product when master has none", () => {
        const masterId = seedMaster();
        seedProduct({ masterId, shop: "rohlik.cz", price: 10, imageUrl: "https://cdn/img.jpg" });

        refreshMasterDenorm(db.raw(), masterId);

        expect(readMaster(masterId).representative_image_url).toBe("https://cdn/img.jpg");
    });

    it("does NOT overwrite a master image that was already set", () => {
        const masterId = seedMaster();
        db.raw().run("UPDATE master_products SET representative_image_url = ? WHERE id = ?", [
            "https://curated/keep.jpg",
            masterId,
        ]);
        seedProduct({ masterId, shop: "rohlik.cz", price: 10, imageUrl: "https://other/skip.jpg" });

        refreshMasterDenorm(db.raw(), masterId);

        expect(readMaster(masterId).representative_image_url).toBe("https://curated/keep.jpg");
    });
});
