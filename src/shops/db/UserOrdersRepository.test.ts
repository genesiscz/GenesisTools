import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserOrdersRepository } from "@app/shops/db/UserOrdersRepository";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { resetCryptoForTest } from "@app/shops/lib/crypto";
import { env } from "@app/utils/env";

async function fresh(): Promise<{ orders: UserOrdersRepository; userProviderId: number }> {
    const dir = mkdtempSync(join(tmpdir(), "shops-uo-"));
    env.testing.set("SHOPS_SECRET_KEY_PATH", join(dir, ".secret-key"));
    resetCryptoForTest();
    const db = new ShopsDatabase(join(dir, "test.db"));
    db.raw().exec(
        `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
         VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`
    );
    const providers = new UserProvidersRepository(db);
    const id = await providers.connect({
        user_id: 1,
        shop_origin: "rohlik.cz",
        credentials: { type: "email-password", email: "a@b", password: "x" },
        external_user_email: "a@b",
    });
    return { orders: new UserOrdersRepository(db), userProviderId: id };
}

describe("UserOrdersRepository", () => {
    it("upsertOrder + upsertOrderItems persists items keyed by line_no", async () => {
        const { orders, userProviderId } = await fresh();
        const orderId = await orders.upsertOrder({
            user_provider_id: userProviderId,
            external_order_id: "1124486322",
            ordered_at: "2026-05-08T15:31:04Z",
            total_amount: 2645.26,
            currency: "CZK",
            items_count: 2,
            state: "delivered",
            raw_json: '{"id":1124486322}',
        });
        expect(orderId).toBeGreaterThan(0);
        await orders.upsertOrderItems(orderId, [
            {
                line_no: 0,
                external_product_id: "717957",
                name: "Kaiserka",
                quantity: 5,
                unit: "g",
                unit_price: 4.9,
                total_price: 24.5,
            },
            {
                line_no: 1,
                external_product_id: "1419780",
                name: "Ritter",
                quantity: 1,
                unit: "ks",
                unit_price: 39.9,
                total_price: 39.9,
            },
        ]);
        const detail = await orders.getOrderWithItems(orderId);
        expect(detail?.items.length).toBe(2);
        expect(detail?.items[0].external_product_id).toBe("717957");
    });

    it("upsertOrder is idempotent on (user_provider_id, external_order_id)", async () => {
        const { orders, userProviderId } = await fresh();
        const a = await orders.upsertOrder({
            user_provider_id: userProviderId,
            external_order_id: "X",
            ordered_at: "2026-05-01T00:00:00Z",
            total_amount: 1,
            currency: "CZK",
            items_count: 0,
            state: null,
            raw_json: null,
        });
        const b = await orders.upsertOrder({
            user_provider_id: userProviderId,
            external_order_id: "X",
            ordered_at: "2026-05-01T00:00:00Z",
            total_amount: 1,
            currency: "CZK",
            items_count: 0,
            state: null,
            raw_json: null,
        });
        expect(b).toBe(a);
    });

    it("markItemMatched sets product_id + master_product_id + matched_at", async () => {
        const dir = mkdtempSync(join(tmpdir(), "shops-uo-mark-"));
        env.testing.set("SHOPS_SECRET_KEY_PATH", join(dir, ".secret-key"));
        resetCryptoForTest();
        const db = new ShopsDatabase(join(dir, "test.db"));
        db.raw().exec(
            `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
             VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`
        );
        db.raw().exec(
            `INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
             VALUES (7,'Kaiserka','kaiserka','kaiserka', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        db.raw().exec(
            `INSERT INTO products (id, shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at)
             VALUES (42,'rohlik.cz','x','https://x','x','x',7,'auto-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
        );
        const providers = new UserProvidersRepository(db);
        const userProviderId = await providers.connect({
            user_id: 1,
            shop_origin: "rohlik.cz",
            credentials: { type: "email-password", email: "a@b", password: "x" },
            external_user_email: "a@b",
        });
        const orders = new UserOrdersRepository(db);

        const orderId = await orders.upsertOrder({
            user_provider_id: userProviderId,
            external_order_id: "Y",
            ordered_at: "2026-05-01T00:00:00Z",
            total_amount: 1,
            currency: "CZK",
            items_count: 1,
            state: null,
            raw_json: null,
        });
        await orders.upsertOrderItems(orderId, [
            {
                line_no: 0,
                external_product_id: "717957",
                name: "x",
                quantity: 1,
                unit: null,
                unit_price: 1,
                total_price: 1,
            },
        ]);
        await orders.markItemMatched(orderId, 0, 42, 7);
        const detail = await orders.getOrderWithItems(orderId);
        expect(detail?.items[0].product_id).toBe(42);
        expect(detail?.items[0].master_product_id).toBe(7);
        expect(detail?.items[0].matched_at).not.toBeNull();
    });
});
