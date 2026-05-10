import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationsRepository } from "@app/shops/db/NotificationsRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { DispatchResult, NotificationChannel, NotificationPayload } from "@app/shops/lib/channels/types";
import { NotificationDispatcher } from "@app/shops/lib/notification-dispatcher";

function tmpDb(): { db: ShopsDatabase; repo: NotificationsRepository; favId: number; masterId: number } {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-disp-")), "test.db"));
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
    return { db, repo: new NotificationsRepository(db), favId, masterId };
}

const PAYLOAD = (id: number, favId: number, masterId: number): NotificationPayload => ({
    notification: {
        id,
        favorite_id: favId,
        master_product_id: masterId,
        product_id: null,
        fired_at: "2026-05-08T10:00:00Z",
        reason: "target-price",
        prev_price: 50,
        curr_price: 29,
        shop_origin: "rohlik.cz",
        delivered_macos_at: null,
        delivered_web_at: null,
        delivered_telegram_at: null,
        delivery_error: null,
        acknowledged_at: null,
        metadata_json: "{}",
    },
    title: "test",
    body: "body",
    detailUrl: `/master/${masterId}`,
    buyUrl: null,
});

class StubChannel implements NotificationChannel {
    constructor(
        readonly name: "macos" | "web" | "telegram",
        private readonly result: DispatchResult,
        readonly calls: NotificationPayload[] = []
    ) {}
    available(): boolean {
        return true;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult> {
        this.calls.push(payload);
        return this.result;
    }
}

describe("NotificationDispatcher", () => {
    it("invokes every available channel in parallel", async () => {
        const { db, repo, favId, masterId } = tmpDb();
        const id = await repo.record({
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        const web = new StubChannel("web", { channel: "web", delivered: true });
        const macos = new StubChannel("macos", { channel: "macos", delivered: true });
        const tg = new StubChannel("telegram", { channel: "telegram", delivered: true });
        const dispatcher = new NotificationDispatcher({ repo, channels: [web, macos, tg] });

        const results = await dispatcher.dispatch(PAYLOAD(id, favId, masterId));
        expect(results.map((r) => r.channel).sort()).toEqual(["macos", "telegram", "web"]);
        expect(web.calls).toHaveLength(1);
        expect(macos.calls).toHaveLength(1);
        expect(tg.calls).toHaveLength(1);
        db.close();
    });

    it("writes delivered_*_at typed columns for each successful channel", async () => {
        const { db, repo, favId, masterId } = tmpDb();
        const id = await repo.record({
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        const dispatcher = new NotificationDispatcher({
            repo,
            channels: [
                new StubChannel("web", { channel: "web", delivered: true }),
                new StubChannel("macos", { channel: "macos", delivered: true }),
            ],
        });
        await dispatcher.dispatch(PAYLOAD(id, favId, masterId));
        const rows = await repo.listAll();
        const row = rows[0];
        expect(row.delivered_web_at).not.toBeNull();
        expect(row.delivered_macos_at).not.toBeNull();
        expect(row.delivered_telegram_at).toBeNull();
        db.close();
    });

    it("records the last failure as delivery_error, others still mark delivered", async () => {
        const { db, repo, favId, masterId } = tmpDb();
        const id = await repo.record({
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        const dispatcher = new NotificationDispatcher({
            repo,
            channels: [
                new StubChannel("web", { channel: "web", delivered: true }),
                new StubChannel("telegram", { channel: "telegram", delivered: false, error: "401 Unauthorized" }),
            ],
        });
        await dispatcher.dispatch(PAYLOAD(id, favId, masterId));
        const rows = await repo.listAll();
        const row = rows[0];
        expect(row.delivered_web_at).not.toBeNull();
        expect(row.delivered_telegram_at).toBeNull();
        expect(row.delivery_error).toContain("401 Unauthorized");
        db.close();
    });

    it("skips channels whose available() returns false", async () => {
        const { db, repo, favId, masterId } = tmpDb();
        const id = await repo.record({
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        class UnavailableChannel implements NotificationChannel {
            readonly name = "macos" as const;
            available(): boolean {
                return false;
            }

            async dispatch(): Promise<DispatchResult> {
                throw new Error("should not be called");
            }
        }

        const dispatcher = new NotificationDispatcher({
            repo,
            channels: [new UnavailableChannel(), new StubChannel("web", { channel: "web", delivered: true })],
        });
        const results = await dispatcher.dispatch(PAYLOAD(id, favId, masterId));
        expect(results).toHaveLength(1);
        expect(results[0].channel).toBe("web");
        db.close();
    });

    it("never throws even if a channel rejects", async () => {
        const { db, repo, favId, masterId } = tmpDb();
        const id = await repo.record({
            favorite_id: favId,
            master_product_id: masterId,
            product_id: null,
            reason: "target-price",
            prev_price: 50,
            curr_price: 29,
            shop_origin: "rohlik.cz",
            metadata: {},
        });
        class ThrowingChannel implements NotificationChannel {
            readonly name = "telegram" as const;
            available(): boolean {
                return true;
            }

            async dispatch(): Promise<DispatchResult> {
                throw new Error("connection refused");
            }
        }

        const dispatcher = new NotificationDispatcher({
            repo,
            channels: [new ThrowingChannel()],
        });
        const results = await dispatcher.dispatch(PAYLOAD(id, favId, masterId));
        expect(results[0].delivered).toBe(false);
        expect(results[0].error).toContain("connection refused");
        const rows = await repo.listAll();
        const row = rows[0];
        expect(row.delivery_error).toContain("connection refused");
        db.close();
    });
});
