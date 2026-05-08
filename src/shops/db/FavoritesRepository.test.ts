import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FavoritesRepository } from "./FavoritesRepository";
import { ShopsDatabase } from "./ShopsDatabase";

function fixture(): { db: ShopsDatabase; repo: FavoritesRepository; masterId: number; productId: number } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-fav-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    db.raw().exec(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
         VALUES ('Ritter Sport mléčná 100g','ritter sport mlecna 100g','ritter-sport-mlecna-100g',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
    const masterRow = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
    if (!masterRow) {
        throw new Error("master insert failed");
    }
    const masterId = masterRow.id;
    db.raw().exec(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at)
         VALUES ('rohlik.cz','1419780','https://www.rohlik.cz/1419780','Ritter Sport','ritter sport',
                 ${masterId}, 'auto-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
    const productRow = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
    if (!productRow) {
        throw new Error("product insert failed");
    }
    const productId = productRow.id;
    db.raw().exec(
        `INSERT INTO prices (product_id, observed_at, current_price, original_price, in_stock, source)
         VALUES (${productId}, '2026-05-08T10:00:00Z', 39.9, 49.9, 1, 'hlidac-s3')`
    );
    return { db, repo: new FavoritesRepository(db), masterId, productId };
}

describe("FavoritesRepository", () => {
    it("addFavorite inserts a master-scoped row with reference_price", async () => {
        const { db, repo, masterId } = fixture();
        const id = await repo.addFavorite({
            master_product_id: masterId,
            restricted_to_shop: null,
            target_price: 35,
            drop_percent: 0.15,
            drop_absolute: null,
            reference_price: 49.9,
            label: "morning chocolate",
            cooldown_hours: 24,
        });
        expect(id).toBeGreaterThan(0);
        db.close();
    });

    it("addFavorite enforces UNIQUE(master_product_id, restricted_to_shop) when restricted_to_shop is non-NULL", async () => {
        const { db, repo, masterId } = fixture();
        await repo.addFavorite({
            master_product_id: masterId,
            restricted_to_shop: "rohlik.cz",
            target_price: 35,
            drop_percent: null,
            drop_absolute: null,
            reference_price: 49.9,
            label: null,
            cooldown_hours: 24,
        });
        await expect(
            repo.addFavorite({
                master_product_id: masterId,
                restricted_to_shop: "rohlik.cz",
                target_price: 30,
                drop_percent: null,
                drop_absolute: null,
                reference_price: 49.9,
                label: null,
                cooldown_hours: 24,
            })
        ).rejects.toThrow();
        db.close();
    });

    it("listActive returns only active=1 rows", async () => {
        const { db, repo, masterId } = fixture();
        const id = await repo.addFavorite({
            master_product_id: masterId,
            restricted_to_shop: null,
            target_price: 35,
            drop_percent: null,
            drop_absolute: null,
            reference_price: 49.9,
            label: null,
            cooldown_hours: 24,
        });
        expect((await repo.listActive()).length).toBe(1);
        await repo.removeFavorite(id);
        expect((await repo.listActive()).length).toBe(0);
        db.close();
    });

    it("listWithCurrentState joins current_offers + delta", async () => {
        const { db, repo, masterId } = fixture();
        await repo.addFavorite({
            master_product_id: masterId,
            restricted_to_shop: null,
            target_price: 35,
            drop_percent: 0.15,
            drop_absolute: null,
            reference_price: 49.9,
            label: null,
            cooldown_hours: 24,
        });
        const rows = await repo.listWithCurrentState();
        expect(rows).toHaveLength(1);
        expect(rows[0].best_price).toBe(39.9);
        expect(rows[0].best_shop).toBe("rohlik.cz");
        expect(rows[0].delta_percent).toBeCloseTo(0.2004, 3);
        db.close();
    });

    it("editFavorite updates fields in-place", async () => {
        const { db, repo, masterId } = fixture();
        const id = await repo.addFavorite({
            master_product_id: masterId,
            restricted_to_shop: null,
            target_price: 35,
            drop_percent: null,
            drop_absolute: null,
            reference_price: 49.9,
            label: null,
            cooldown_hours: 24,
        });
        await repo.editFavorite(id, { target_price: 30, label: "weekend treat" });
        const after = await repo.getFavorite(id);
        expect(after?.target_price).toBe(30);
        expect(after?.label).toBe("weekend treat");
        db.close();
    });
});
