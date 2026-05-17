import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase, setShopsDatabaseSingletonForTest } from "@app/shops/db/ShopsDatabase";
import { addFavoriteByMaster } from "@app/shops/lib/watchlist-api";

function tmpDb(): ShopsDatabase {
    const path = join(mkdtempSync(join(tmpdir(), "shops-watchapi-")), "test.db");
    const db = new ShopsDatabase(path);
    db.raw().exec(`
        INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
        VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none');

        INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
        VALUES (1,'Ritter Sport','ritter sport','ritter-sport','2026-05-08T10:00:00Z','2026-05-08T10:00:00Z');
    `);
    return db;
}

describe("addFavoriteByMaster — duplicate handling", () => {
    it("returns existing favorite_id with already_exists=true on second call (no second row)", async () => {
        const db = tmpDb();
        setShopsDatabaseSingletonForTest(db);

        const first = await addFavoriteByMaster(1, { master_product_id: 1 });
        expect(first.already_exists).toBeFalsy();
        expect(first.favorite_id).toBeGreaterThan(0);

        const second = await addFavoriteByMaster(1, { master_product_id: 1 });
        expect(second.already_exists).toBe(true);
        expect(second.favorite_id).toBe(first.favorite_id);

        const count = db.raw().query<{ c: number }, []>("SELECT COUNT(*) AS c FROM favorites WHERE user_id = 1").get();
        expect(count?.c).toBe(1);

        setShopsDatabaseSingletonForTest(null);
        db.close();
    });

    it("treats NULL restricted_to_shop and 'rohlik.cz' as DIFFERENT favorites for the same user", async () => {
        const db = tmpDb();
        setShopsDatabaseSingletonForTest(db);

        const anyShop = await addFavoriteByMaster(1, { master_product_id: 1 });
        const restricted = await addFavoriteByMaster(1, { master_product_id: 1, restricted_to_shop: "rohlik.cz" });
        expect(restricted.already_exists).toBeFalsy();
        expect(restricted.favorite_id).not.toBe(anyShop.favorite_id);

        const count = db.raw().query<{ c: number }, []>("SELECT COUNT(*) AS c FROM favorites WHERE user_id = 1").get();
        expect(count?.c).toBe(2);

        setShopsDatabaseSingletonForTest(null);
        db.close();
    });

    it("scopes by user — same master for different users does not collide", async () => {
        const db = tmpDb();
        setShopsDatabaseSingletonForTest(db);
        db.raw().exec(
            `INSERT INTO users (email, display_name, created_at, updated_at)
             VALUES ('b@x','b@x', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        const userBRow = db.raw().query<{ id: number }, []>("SELECT id FROM users WHERE email='b@x'").get();
        const userB = userBRow?.id ?? 0;

        const a = await addFavoriteByMaster(1, { master_product_id: 1 });
        const b = await addFavoriteByMaster(userB, { master_product_id: 1 });
        expect(a.already_exists).toBeFalsy();
        expect(b.already_exists).toBeFalsy();
        expect(b.favorite_id).not.toBe(a.favorite_id);

        setShopsDatabaseSingletonForTest(null);
        db.close();
    });
});
