import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FavoritesRepository } from "@app/shops/db/FavoritesRepository";
import { NotificationsRepository } from "@app/shops/db/NotificationsRepository";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { DispatchResult, NotificationChannel, NotificationPayload } from "@app/shops/lib/channels/types";
import { NotificationDispatcher } from "@app/shops/lib/notification-dispatcher";
import { WatchlistEvaluator } from "@app/shops/lib/watchlist-evaluator";

class CapturingChannel implements NotificationChannel {
    readonly name = "web" as const;
    public received: NotificationPayload[] = [];
    available(): boolean {
        return true;
    }

    async dispatch(p: NotificationPayload): Promise<DispatchResult> {
        this.received.push(p);
        return { channel: "web", delivered: true };
    }
}

interface Seed {
    targetPrice?: number | null;
    dropPercent?: number | null;
    dropAbsolute?: number | null;
    referencePrice: number;
    currentPrice: number | null;
    inStock?: number | null;
    cooldownHours?: number;
    restrictedToShop?: string | null;
}

function seed(input: Seed) {
    const dbPath = join(mkdtempSync(join(tmpdir(), "shops-eval-")), "test.db");
    const db = new ShopsDatabase(dbPath);
    db.raw().exec(`INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
                   VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`);
    db.raw().exec(
        `INSERT INTO master_products (canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
         VALUES ('Ritter Sport','ritter sport','ritter-sport',
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
    if (input.currentPrice !== null) {
        const stockSql = input.inStock === null ? "NULL" : String(input.inStock ?? 1);
        db.raw().exec(
            `INSERT INTO prices (product_id, observed_at, current_price, original_price, in_stock, source)
             VALUES (${productId}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${input.currentPrice}, NULL, ${stockSql}, 'hlidac-s3')`
        );
    }

    const favRepo = new FavoritesRepository(db);
    const notifRepo = new NotificationsRepository(db);
    return { db, dbPath, masterId, productId, favRepo, notifRepo, input };
}

function recordStock(env: Awaited<ReturnType<typeof seed>>, observedAt: string, inStock: number | null): void {
    env.db.raw().run(
        `INSERT INTO prices (product_id, observed_at, current_price, original_price, in_stock, source)
         VALUES (?, ?, ?, NULL, ?, 'fixture')`,
        [env.productId, observedAt, env.input.currentPrice, inStock]
    );
}

async function makeFav(env: Awaited<ReturnType<typeof seed>>, args: Partial<Seed> = {}) {
    return env.favRepo.addFavorite(1, {
        master_product_id: env.masterId,
        restricted_to_shop: env.input.restrictedToShop ?? null,
        target_price: args.targetPrice ?? env.input.targetPrice ?? null,
        drop_percent: args.dropPercent ?? env.input.dropPercent ?? null,
        drop_absolute: args.dropAbsolute ?? env.input.dropAbsolute ?? null,
        reference_price: args.referencePrice ?? env.input.referencePrice,
        label: null,
        cooldown_hours: env.input.cooldownHours ?? 24,
    });
}

describe("WatchlistEvaluator.tick", () => {
    it("fires target-price when current ≤ target", async () => {
        const env = seed({ targetPrice: 40, referencePrice: 50, currentPrice: 39.9 });
        await makeFav(env);
        const ch = new CapturingChannel();
        const ev = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
        });
        const report = await ev.tick();
        expect(report.fired).toBe(1);
        expect(ch.received[0].notification.reason).toBe("target-price");
        env.db.close();
    });

    it("fires drop-percent when (ref - cur) / ref >= drop_percent", async () => {
        const env = seed({ dropPercent: 0.15, referencePrice: 50, currentPrice: 42 });
        await makeFav(env);
        const ch = new CapturingChannel();
        const ev = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
        });
        const report = await ev.tick();
        expect(report.fired).toBe(1);
        expect(ch.received[0].notification.reason).toBe("drop-percent");
        env.db.close();
    });

    it("fires drop-absolute when (ref - cur) >= drop_absolute", async () => {
        const env = seed({ dropAbsolute: 5, referencePrice: 50, currentPrice: 44 });
        await makeFav(env);
        const ch = new CapturingChannel();
        const ev = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
        });
        const report = await ev.tick();
        expect(report.fired).toBe(1);
        expect(ch.received[0].notification.reason).toBe("drop-absolute");
        env.db.close();
    });

    it("fires back-in-stock only after the same product transitions from known unavailable to available", async () => {
        const env = seed({ targetPrice: null, referencePrice: 50, currentPrice: 50, inStock: 1 });
        const favoriteId = await env.favRepo.addFavorite(1, {
            master_product_id: env.masterId,
            restricted_to_shop: null,
            target_price: null,
            drop_percent: null,
            drop_absolute: null,
            reference_price: 50,
            label: null,
            cooldown_hours: 24,
            notify_back_in_stock: true,
        });
        const ch = new CapturingChannel();
        const ev = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
        });

        expect((await ev.tick()).fired).toBe(0);
        recordStock(env, "2099-01-01T00:00:00.000Z", 0);
        expect((await ev.tick()).fired).toBe(0);
        recordStock(env, "2099-01-02T00:00:00.000Z", 1);
        expect((await ev.tick()).fired).toBe(1);
        expect(ch.received[0].notification.reason).toBe("back-in-stock");
        expect(ch.received[0].notification.product_id).toBe(env.productId);
        expect((await ev.tick()).fired).toBe(0);
        env.db
            .raw()
            .run("UPDATE notifications SET fired_at = ? WHERE reason = 'back-in-stock'", ["2000-01-01T00:00:00.000Z"]);
        recordStock(env, "2099-01-03T00:00:00.000Z", 0);
        expect((await ev.tick()).fired).toBe(0);
        recordStock(env, "2099-01-04T00:00:00.000Z", 1);
        expect((await ev.tick()).fired).toBe(1);
        expect(ch.received).toHaveLength(2);
        const staleAccepted = await env.favRepo.recordStockObservation(favoriteId, {
            productId: env.productId,
            shopOrigin: "rohlik.cz",
            inStock: 0,
            observedAt: "2099-01-03T12:00:00.000Z",
        });
        expect(staleAccepted).toBe(false);
        const afterStale = (await env.favRepo.listAllWithCurrentState())[0];
        expect(afterStale.last_stock_state).toBe(1);
        expect(afterStale.last_stock_observed_at).toBe("2099-01-04T00:00:00.000Z");
        env.db.close();
    });

    it("does not infer back-in-stock from first available, currently unavailable, or unknown observations", async () => {
        for (const [label, stock] of [
            ["available", 1],
            ["unavailable", 0],
            ["unknown", null],
        ] as const) {
            const env = seed({ targetPrice: null, referencePrice: 50, currentPrice: 50, inStock: stock });
            await env.favRepo.addFavorite(1, {
                master_product_id: env.masterId,
                restricted_to_shop: null,
                target_price: null,
                drop_percent: null,
                drop_absolute: null,
                reference_price: 50,
                label,
                cooldown_hours: 24,
                notify_back_in_stock: true,
            });
            const ch = new CapturingChannel();
            const ev = new WatchlistEvaluator({
                db: env.db,
                favorites: env.favRepo,
                notifications: env.notifRepo,
                dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
            });

            expect((await ev.tick()).fired).toBe(0);
            expect(ch.received).toHaveLength(0);
            env.db.close();
        }
    });

    it("suppresses a stale back-in-stock hit when a newer unavailable observation wins the state write", async () => {
        const env = seed({ targetPrice: null, referencePrice: 50, currentPrice: 50, inStock: 0 });
        await env.favRepo.addFavorite(1, {
            master_product_id: env.masterId,
            restricted_to_shop: null,
            target_price: null,
            drop_percent: null,
            drop_absolute: null,
            reference_price: 50,
            label: null,
            cooldown_hours: 24,
            notify_back_in_stock: true,
        });
        const channel = new CapturingChannel();
        const evaluator = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [channel] }),
        });
        expect((await evaluator.tick()).fired).toBe(0);
        recordStock(env, "2099-02-01T00:00:00.000Z", 1);
        const recordObservation = env.favRepo.recordStockObservation.bind(env.favRepo);
        let injectedNewerObservation = false;
        env.favRepo.recordStockObservation = async (favoriteId, observation) => {
            if (!injectedNewerObservation) {
                injectedNewerObservation = true;
                recordStock(env, "2099-02-02T00:00:00.000Z", 0);
                await recordObservation(favoriteId, {
                    ...observation,
                    inStock: 0,
                    observedAt: "2099-02-02T00:00:00.000Z",
                });
            }

            return recordObservation(favoriteId, observation);
        };

        expect((await evaluator.tick()).fired).toBe(0);
        expect(channel.received).toHaveLength(0);
        env.favRepo.recordStockObservation = recordObservation;
        recordStock(env, "2099-02-03T00:00:00.000Z", 1);
        expect((await evaluator.tick()).fired).toBe(1);
        expect(channel.received).toHaveLength(1);
        env.db.close();
    });

    it("respects cooldown — does not double-fire same reason within window", async () => {
        const env = seed({ targetPrice: 40, referencePrice: 50, currentPrice: 39.9, cooldownHours: 24 });
        await makeFav(env);
        const ch = new CapturingChannel();
        const ev = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
        });
        const r1 = await ev.tick();
        const r2 = await ev.tick();
        expect(r1.fired).toBe(1);
        expect(r2.fired).toBe(0);
        expect(r2.skippedCooldown).toBe(1);
        env.db.close();
    });

    it("claims one cooldown notification across simultaneous evaluators and database connections", async () => {
        const env = seed({ targetPrice: 40, referencePrice: 50, currentPrice: 39.9, cooldownHours: 24 });
        await makeFav(env);
        const secondDb = new ShopsDatabase(env.dbPath);
        const secondFavorites = new FavoritesRepository(secondDb);
        const secondNotifications = new NotificationsRepository(secondDb);
        const firstChannel = new CapturingChannel();
        const secondChannel = new CapturingChannel();
        const first = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [firstChannel] }),
        });
        const second = new WatchlistEvaluator({
            db: secondDb,
            favorites: secondFavorites,
            notifications: secondNotifications,
            dispatcher: new NotificationDispatcher({ repo: secondNotifications, channels: [secondChannel] }),
        });

        const reports = await Promise.all([first.tick(), second.tick()]);
        expect(reports.reduce((sum, report) => sum + report.fired, 0)).toBe(1);
        expect(firstChannel.received.length + secondChannel.received.length).toBe(1);
        expect(await env.notifRepo.listAll(1)).toHaveLength(1);
        secondDb.close();
        env.db.close();
    });

    it("does not fire when no current offer exists for the favorite scope", async () => {
        const env = seed({ targetPrice: 40, referencePrice: 50, currentPrice: null });
        await makeFav(env);
        const ch = new CapturingChannel();
        const ev = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
        });
        const report = await ev.tick();
        expect(report.fired).toBe(0);
        expect(report.skippedNoOffer).toBe(1);
        env.db.close();
    });

    it("when multiple thresholds hit, fires the highest-priority reason only (target-price > drop-percent > drop-absolute > back-in-stock)", async () => {
        const env = seed({
            targetPrice: 40,
            dropPercent: 0.1,
            dropAbsolute: 1,
            referencePrice: 50,
            currentPrice: 39.9,
        });
        await makeFav(env);
        const ch = new CapturingChannel();
        const ev = new WatchlistEvaluator({
            db: env.db,
            favorites: env.favRepo,
            notifications: env.notifRepo,
            dispatcher: new NotificationDispatcher({ repo: env.notifRepo, channels: [ch] }),
        });
        const report = await ev.tick();
        expect(report.fired).toBe(1);
        expect(ch.received[0].notification.reason).toBe("target-price");
        env.db.close();
    });
});
