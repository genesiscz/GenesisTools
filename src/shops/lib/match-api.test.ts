import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { acceptCandidatePair, listPendingCandidates, rejectCandidatePair } from "./match-api";

function setup() {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-mapi-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    const now = new Date().toISOString();
    db.raw().run(
        `INSERT INTO products (shop_origin, slug, url, name, name_normalized, match_method, first_seen_at, last_updated_at, is_active)
         VALUES ('rohlik.cz', 'p1', 'http://1', 'P1', 'p1', 'fuzzy', ?, ?, 1),
                ('rohlik.cz', 'p2', 'http://2', 'P2', 'p2', 'fuzzy', ?, ?, 1)`,
        [now, now, now, now]
    );
    const ids = db
        .raw()
        .query<{ id: number }, []>("SELECT id FROM products ORDER BY id")
        .all()
        .map((r) => r.id);
    db.raw().run(
        `INSERT INTO match_candidates (product_id_a, product_id_b, similarity, match_method, status, created_at)
         VALUES (?, ?, 0.93, 'fuzzy-brand-name', 'pending', ?)`,
        [ids[0], ids[1], now]
    );
    return { db, ids };
}

describe("listPendingCandidates", () => {
    it("returns the pending pair with full product info", async () => {
        const { db } = setup();
        const pairs = await listPendingCandidates({ shopsDb: db });
        expect(pairs).toHaveLength(1);
        expect(pairs[0].similarity).toBe(0.93);
        expect(pairs[0].method).toBe("fuzzy-brand-name");
        expect(pairs[0].productA.name).toBe("P1");
        expect(pairs[0].productB.name).toBe("P2");
        db.close();
    });
});

describe("rejectCandidatePair", () => {
    it("flips status to rejected", async () => {
        const { db, ids } = setup();
        await rejectCandidatePair({ shopsDb: db, productIdA: ids[0], productIdB: ids[1] });
        const status = db.raw().query<{ status: string }, []>("SELECT status FROM match_candidates").get()?.status;
        expect(status).toBe("rejected");
        db.close();
    });
});

describe("acceptCandidatePair", () => {
    it("merges masters when both products belong to different masters", async () => {
        const { db, ids } = setup();
        const now = new Date().toISOString();
        db.raw().run(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, total_offers, created_at, updated_at, verified_by)
             VALUES ('A', 'a', 'a', 2, ?, ?, 'auto'), ('B', 'b', 'b', 1, ?, ?, 'auto')`,
            [now, now, now, now]
        );
        const masters = db.raw().query<{ id: number }, []>("SELECT id FROM master_products ORDER BY id").all();
        db.raw().run("UPDATE products SET master_product_id = ? WHERE id = ?", [masters[0].id, ids[0]]);
        db.raw().run("UPDATE products SET master_product_id = ? WHERE id = ?", [masters[1].id, ids[1]]);

        await acceptCandidatePair({ shopsDb: db, productIdA: ids[0], productIdB: ids[1] });

        const masterCount = db.raw().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM master_products").get()?.n;
        expect(masterCount).toBe(1);
        db.close();
    });
});
