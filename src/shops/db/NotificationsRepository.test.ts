import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationsRepository } from "@app/shops/db/NotificationsRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";

function fixture() {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-notif-")), "test.db"));
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    db.raw().exec(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
         VALUES ('X','x','x', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
    const masterRow = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
    if (!masterRow) {
        throw new Error("master insert failed");
    }
    const masterId = masterRow.id;
    db.raw().exec(
        `INSERT INTO favorites (master_product_id, target_price, reference_price, cooldown_hours, created_at)
         VALUES (${masterId}, 30, 50, 24, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
    const favRow = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
    if (!favRow) {
        throw new Error("favorite insert failed");
    }
    const favId = favRow.id;
    return { db, repo: new NotificationsRepository(db), masterId, favId };
}

function seedUser(db: ShopsDatabase, email: string): number {
    db.raw().exec(
        `INSERT INTO users (email, display_name, created_at, updated_at)
         VALUES ('${email}', '${email}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
    const r = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() as id").get();
    if (!r) {
        throw new Error("user insert failed");
    }
    return r.id;
}

describe("NotificationsRepository", () => {
    it("record inserts an unacknowledged row with all four delivered_* columns null", async () => {
        const { db, repo, masterId, favId } = fixture();
        const id = await repo.record(1, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        const rows = await repo.listAll(1);
        const row = rows[0];
        expect(row.id).toBe(id);
        expect(row.acknowledged_at).toBeNull();
        expect(row.delivered_macos_at).toBeNull();
        expect(row.delivered_web_at).toBeNull();
        expect(row.delivered_telegram_at).toBeNull();
        db.close();
    });

    it("findRecentByFavoriteAndReason returns last fire within window, otherwise undefined", async () => {
        const { db, repo, masterId, favId } = fixture();
        await repo.record(1, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        const recent = await repo.findRecentByFavoriteAndReason(favId, "target-price", 24);
        expect(recent).toBeDefined();
        const old = await repo.findRecentByFavoriteAndReason(favId, "drop-percent", 24);
        expect(old).toBeUndefined();
        db.close();
    });

    it("findRecentByFavoriteAndReason ignores fires older than window", async () => {
        const { db, repo, masterId, favId } = fixture();
        const olderIso = new Date(Date.now() - 36 * 3_600_000).toISOString();
        db.raw().run(
            `INSERT INTO notifications (favorite_id, master_product_id, fired_at, reason, shop_origin)
             VALUES (?, ?, ?, 'target-price', 'rohlik.cz')`,
            [favId, masterId, olderIso]
        );
        const recent = await repo.findRecentByFavoriteAndReason(favId, "target-price", 24);
        expect(recent).toBeUndefined();
        db.close();
    });

    it("markDelivered sets the typed column for the named channel", async () => {
        const { db, repo, masterId, favId } = fixture();
        const id = await repo.record(1, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        await repo.markDelivered(id, "web");
        await repo.markDelivered(id, "macos");
        const rows = await repo.listAll(1);
        const row = rows.find((r) => r.id === id);
        expect(row).toBeDefined();
        expect(row?.delivered_web_at).not.toBeNull();
        expect(row?.delivered_macos_at).not.toBeNull();
        expect(row?.delivered_telegram_at).toBeNull();
        db.close();
    });

    it("ack and ackAll set acknowledged_at, scoped to user", async () => {
        const { db, repo, masterId, favId } = fixture();
        const id1 = await repo.record(1, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        const id2 = await repo.record(1, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "drop-percent",
            prev_price: 50,
            curr_price: 35,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        await repo.ack(1, id1);
        expect((await repo.listUnacked(1)).map((r) => r.id)).toEqual([id2]);
        await repo.ackAll(1);
        expect((await repo.listUnacked(1)).length).toBe(0);
        db.close();
    });

    it("setDeliveryError records the last failure message", async () => {
        const { db, repo, masterId, favId } = fixture();
        const id = await repo.record(1, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        await repo.setDeliveryError(id, "telegram: 401 Unauthorized");
        const rows = await repo.listAll(1);
        const row = rows.find((r) => r.id === id);
        expect(row?.delivery_error).toBe("telegram: 401 Unauthorized");
        db.close();
    });

    it("listUnacked / ack are scoped: user A cannot ack user B's notifications", async () => {
        const { db, repo, masterId, favId } = fixture();
        const userB = seedUser(db, "b@x");
        const idA = await repo.record(1, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        const idB = await repo.record(userB, {
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "drop-percent",
            prev_price: 50,
            curr_price: 35,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        expect((await repo.listUnacked(1)).map((r) => r.id)).toEqual([idA]);
        expect((await repo.listUnacked(userB)).map((r) => r.id)).toEqual([idB]);
        await repo.ack(1, idB); // user A tries to ack B's
        expect((await repo.listUnacked(userB)).map((r) => r.id)).toEqual([idB]);
        db.close();
    });
});
