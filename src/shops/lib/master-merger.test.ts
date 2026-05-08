import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { MasterMerger } from "./master-merger";

function setup() {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-merge-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    const merger = new MasterMerger(db);
    return { db, merger };
}

describe("MasterMerger.merge", () => {
    it("moves all references to survivor and deletes absorbed", async () => {
        const { db, merger } = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
             VALUES ('A', 'a', 'a', 2, ?, ?, 'auto')`,
            [now, now]
        );
        const survivor = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
             VALUES ('B', 'b', 'b', 1, ?, ?, 'auto')`,
            [now, now]
        );
        const absorbed = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;

        db.raw().run(
            `INSERT INTO products (shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at, is_active)
             VALUES ('rohlik.cz', 'p1', 'http://1', 'P1', 'p1', ?, 'fuzzy', ?, ?, 1),
                    ('rohlik.cz', 'p2', 'http://2', 'P2', 'p2', ?, 'fuzzy', ?, ?, 1)`,
            [absorbed, now, now, absorbed, now, now]
        );

        const result = await merger.merge({ survivorMasterId: survivor, absorbedMasterId: absorbed });
        expect(result.productsMoved).toBe(2);

        const stillThere = db
            .raw()
            .query<{ ok: number }, [number]>("SELECT 1 AS ok FROM master_products WHERE id = ?")
            .get(absorbed);
        expect(stillThere).toBeNull();

        const linked = db
            .raw()
            .query<{ n: number }, [number]>(
                "SELECT COUNT(*) AS n FROM products WHERE master_product_id = ?"
            )
            .get(survivor)!.n;
        expect(linked).toBe(2);
        db.close();
    });

    it("pickSurvivor: higher total_offers wins, tiebreak lower id", async () => {
        const { db, merger } = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by) VALUES ('A', 'a', 'a', 5, ?, ?, 'auto'), ('B', 'b', 'b', 3, ?, ?, 'auto')`,
            [now, now, now, now]
        );
        const ids = db.raw().query<{ id: number }, []>("SELECT id FROM master_products ORDER BY id").all();
        const decision = merger.pickSurvivor(ids[1].id, ids[0].id);
        expect(decision.survivorMasterId).toBe(ids[0].id);
        expect(decision.absorbedMasterId).toBe(ids[1].id);
        db.close();
    });
});
