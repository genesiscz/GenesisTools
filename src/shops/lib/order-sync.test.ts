import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase, setShopsDatabaseSingletonForTest } from "@app/shops/db/ShopsDatabase";
import { UserOrdersRepository } from "@app/shops/db/UserOrdersRepository";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { resetCryptoForTest } from "@app/shops/lib/crypto";
import { type AuthClientFactory, syncProvider } from "@app/shops/lib/order-sync";

async function fixture(): Promise<{ db: ShopsDatabase; userProviderId: number }> {
    const dir = mkdtempSync(join(tmpdir(), "shops-sync-"));
    process.env.SHOPS_SECRET_KEY_PATH = join(dir, ".secret-key");
    resetCryptoForTest();
    const db = new ShopsDatabase(join(dir, "test.db"));
    setShopsDatabaseSingletonForTest(db);

    db.raw().exec(
        `INSERT INTO shops (origin, display_name, currency, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection)
         VALUES ('rohlik.cz','Rohlík.cz','CZK',1,1,1,1,1,'none')`
    );
    db.raw().exec(
        `INSERT INTO master_products (id, canonical_name, canonical_name_normalized, canonical_slug, created_at, updated_at)
         VALUES (1,'Kaiserka natural','kaiserka natural','kaiserka-natural', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
    db.raw().exec(
        `INSERT INTO products (id, shop_origin, slug, url, name, name_normalized, master_product_id, match_method, first_seen_at, last_updated_at)
         VALUES (1,'rohlik.cz','717957','https://www.rohlik.cz/717957','Kaiserka','kaiserka',1,'auto-seed', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );

    const providers = new UserProvidersRepository(db);
    const userProviderId = await providers.connect({
        user_id: 1,
        shop_origin: "rohlik.cz",
        credentials: { type: "email-password", email: "a@b", password: "x" },
        external_user_email: "a@b",
    });

    return { db, userProviderId };
}

const fakeRohlikFactory: AuthClientFactory = () => ({
    kind: "rohlik",
    async getProfile() {
        return { email: "a@b" };
    },
    async listOrders() {
        return [
            {
                external_order_id: "111",
                ordered_at: "2026-05-08T15:31:04Z",
                total_amount: 24.5,
                currency: "CZK",
                items_count: 1,
                state: "delivered",
            },
        ];
    },
    async getOrderDetail() {
        return {
            external_order_id: "111",
            raw_json: '{"id":111}',
            items: [
                {
                    line_no: 0,
                    external_product_id: "717957",
                    name: "Kaiserka",
                    quantity: 5,
                    unit: "g",
                    unit_price: 4.9,
                    total_price: 24.5,
                },
            ],
        };
    },
});

describe("syncProvider", () => {
    it("ingests new orders, resolves items by slug, marks them matched", async () => {
        const { db, userProviderId } = await fixture();
        const result = await syncProvider({ userProviderId, factory: fakeRohlikFactory });
        expect(result.orders_new).toBe(1);
        expect(result.items_matched).toBe(1);

        const orders = new UserOrdersRepository(db);
        const list = await orders.listForUserProvider(userProviderId);
        const detail = await orders.getOrderWithItems(list[0].id);
        expect(detail?.items[0].master_product_id).toBe(1);
        expect(detail?.items[0].product_id).toBe(1);
        setShopsDatabaseSingletonForTest(null);
    });

    it("is idempotent — second run does nothing new", async () => {
        const { userProviderId } = await fixture();
        await syncProvider({ userProviderId, factory: fakeRohlikFactory });
        const second = await syncProvider({ userProviderId, factory: fakeRohlikFactory });
        expect(second.orders_new).toBe(0);
        setShopsDatabaseSingletonForTest(null);
    });
});
