import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase, setShopsDatabaseSingletonForTest } from "@app/shops/db/ShopsDatabase";
import { backfillWatchlist } from "@app/shops/lib/order-sync-backfill";
import { nowUtcIso } from "@app/utils/sql-time";

afterEach(() => {
    setShopsDatabaseSingletonForTest(null);
});

function fixture(): { db: ShopsDatabase; userProviderId: number; masters: number[] } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-bf-")), "test.db"));
    setShopsDatabaseSingletonForTest(db);
    const r = db.raw();

    r.exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
            VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);

    r.exec(
        `INSERT INTO user_providers (user_id, shop_origin, status, watchlist_defaults_json, created_at, updated_at)
         VALUES (1, 'rohlik.cz', 'connected', '{"drop_percent":0.05,"cooldown_hours":12}', '${nowUtcIso()}', '${nowUtcIso()}')`
    );
    const upId = r.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
    if (!upId) {
        throw new Error("provider insert failed");
    }
    const userProviderId = upId.id;

    const masters: number[] = [];
    for (const slug of ["alpha", "beta"]) {
        r.exec(
            `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
             VALUES ('${slug}','${slug}','${slug}','${nowUtcIso()}','${nowUtcIso()}')`
        );
        const m = r.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
        if (!m) {
            throw new Error("master insert failed");
        }
        masters.push(m.id);
    }

    r.exec(
        `INSERT INTO user_orders (user_provider_id, external_order_id, ordered_at, total_amount, currency, items_count, ingested_at)
         VALUES (${userProviderId}, 'ORD-1', '${nowUtcIso()}', 100, 'CZK', 2, '${nowUtcIso()}')`
    );
    const ord = r.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
    if (!ord) {
        throw new Error("order insert failed");
    }
    const orderId = ord.id;

    r.exec(
        `INSERT INTO user_order_items (order_id, line_no, name, master_product_id, matched_at)
         VALUES (${orderId}, 1, 'alpha', ${masters[0]}, '${nowUtcIso()}'),
                (${orderId}, 2, 'beta', ${masters[1]}, '${nowUtcIso()}'),
                (${orderId}, 3, 'unmatched', NULL, NULL)`
    );

    return { db, userProviderId, masters };
}

describe("backfillWatchlist", () => {
    it("adds a favorite per distinct matched master_product_id", async () => {
        const { db, userProviderId } = fixture();
        const result = await backfillWatchlist({ userId: 1, userProviderId });
        expect(result.candidates).toBe(2);
        expect(result.added).toBe(2);
        expect(result.already_present).toBe(0);
        const cnt = db.raw().query<{ c: number }, []>("SELECT COUNT(*) AS c FROM favorites WHERE user_id = 1").get();
        expect(cnt?.c).toBe(2);
        db.close();
    });

    it("is idempotent: a second call adds nothing", async () => {
        const { db, userProviderId } = fixture();
        await backfillWatchlist({ userId: 1, userProviderId });
        const second = await backfillWatchlist({ userId: 1, userProviderId });
        expect(second.added).toBe(0);
        expect(second.already_present).toBe(2);
        db.close();
    });

    it("rejects when provider doesn't belong to the user", async () => {
        const { db, userProviderId } = fixture();
        await expect(backfillWatchlist({ userId: 999, userProviderId })).rejects.toThrow(/provider not found/);
        db.close();
    });
});
