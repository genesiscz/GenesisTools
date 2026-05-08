import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { acceptPair, rejectPair, rematchProduct } from "./match";

function setup() {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-mc-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('kosik.cz','Košík.cz','CZK',1,1,1,1,1,'none')`);
    return db;
}

describe("acceptPair", () => {
    it("merges masters when both products belong to different masters", async () => {
        const db = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
             VALUES ('A', 'a', 'a', 2, ?, ?, 'auto'), ('B', 'b', 'b', 1, ?, ?, 'auto')`,
            [now, now, now, now]
        );
        const masters = db.raw().query<{ id: number }, []>("SELECT id FROM master_products ORDER BY id").all();

        db.raw().run(
            `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at, is_active)
             VALUES ('rohlik.cz', 'p1', 'http://1', 'P1', 'p1', ?, 'fuzzy', ?, ?, 1),
                    ('kosik.cz', 'p2', 'http://2', 'P2', 'p2', ?, 'fuzzy', ?, ?, 1)`,
            [masters[0].id, now, now, masters[1].id, now, now]
        );
        const ids = db.raw().query<{ id: number }, []>("SELECT id FROM products ORDER BY id").all();

        await acceptPair({ shopsDb: db, productIdA: ids[0].id, productIdB: ids[1].id });

        const masterCount = db.raw().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM master_products").get()?.n;
        expect(masterCount).toBe(1);
        db.close();
    });
});

describe("rejectPair", () => {
    it("inserts/updates match_candidates with status=rejected", async () => {
        const db = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO products (shop_origin, slug, url, name, name_normalized, match_method, first_seen_at, last_updated_at, is_active)
             VALUES ('rohlik.cz', 'p1', 'http://1', 'P1', 'p1', 'fuzzy', ?, ?, 1),
                    ('kosik.cz', 'p2', 'http://2', 'P2', 'p2', 'fuzzy', ?, ?, 1)`,
            [now, now, now, now]
        );
        const ids = db.raw().query<{ id: number }, []>("SELECT id FROM products ORDER BY id").all();

        await rejectPair({ shopsDb: db, productIdA: ids[0].id, productIdB: ids[1].id });

        const cand = db
            .raw()
            .query<{ product_id_a: number; product_id_b: number; status: string; reviewed_by: string }, []>(
                "SELECT product_id_a, product_id_b, status, reviewed_by FROM match_candidates"
            )
            .get();
        expect(cand?.product_id_a).toBeLessThan(cand?.product_id_b ?? Infinity);
        expect(cand?.status).toBe("rejected");
        expect(cand?.reviewed_by).toBe("user");
        db.close();
    });
});

describe("rematchProduct", () => {
    it("resets master_product_id and bumps match_at", async () => {
        const db = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
             VALUES ('A', 'a', 'a', 1, ?, ?, 'auto')`,
            [now, now]
        );
        const masterId = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
        db.raw().run(
            `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id, match_method, match_at, first_seen_at, last_updated_at, is_active)
             VALUES ('rohlik.cz', 'p1', 'http://1', 'P', 'p', ?, 'fuzzy', '2020-01-01T00:00:00Z', ?, ?, 1)`,
            [masterId, now, now]
        );
        const productId = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;

        await rematchProduct({ shopsDb: db, productId });

        const after = db
            .raw()
            .query<{ master_product_id: number | null; match_at: string }, [number]>(
                "SELECT master_product_id, match_at FROM products WHERE id = ?"
            )
            .get(productId);
        expect(after?.master_product_id).toBeNull();
        expect(new Date(after!.match_at).getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());
        db.close();
    });
});
