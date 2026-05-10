import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __resetInitState, initShopRegistry } from "@app/shops/api/registry-init";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { syncShopsFromRegistry } from "@app/shops/lib/sync-shops-from-registry";

let db: ShopsDatabase;

beforeEach(() => {
    db = buildTestDatabase();
    ShopRegistry.reset();
    __resetInitState();
    initShopRegistry();
});

afterEach(() => {
    db.close();
    ShopRegistry.reset();
    __resetInitState();
});

interface ShopRow {
    origin: string;
    display_name: string;
    cap_live: number;
    cap_history: number;
    cap_listing: number;
    cap_ean: number;
    cap_search: number;
    bot_protection: string;
}

function readShop(origin: string): ShopRow | undefined {
    return (
        db
            .raw()
            .query<ShopRow, [string]>(
                "SELECT origin, display_name, cap_live, cap_history, cap_listing, cap_ean, cap_search, bot_protection FROM shops WHERE origin = ?"
            )
            .get(origin) ?? undefined
    );
}

describe("syncShopsFromRegistry", () => {
    it("populates rohlik.cz with full capabilities and proper display_name", async () => {
        await syncShopsFromRegistry(db);

        const row = readShop("rohlik.cz");
        expect(row).toBeDefined();
        expect(row?.display_name).toBe("Rohlík.cz");
        expect(row?.cap_live).toBe(1);
        expect(row?.cap_history).toBe(1);
        expect(row?.cap_listing).toBe(1);
        expect(row?.cap_ean).toBe(1);
    });

    it("propagates each client's bot_protection value", async () => {
        await syncShopsFromRegistry(db);

        const kaufland = readShop("kaufland.cz");
        expect(kaufland?.bot_protection).not.toBe("none");
    });

    it("overwrites stale rows produced by ingest defaults", async () => {
        await db.upsertShop({
            origin: "rohlik.cz",
            display_name: "rohlik.cz",
            currency: "CZK",
            cap_live: 0,
            cap_history: 1,
            cap_listing: 0,
            cap_ean: 0,
            cap_search: 0,
            bot_protection: "none",
        });

        await syncShopsFromRegistry(db);

        const row = readShop("rohlik.cz");
        expect(row?.cap_live).toBe(1);
        expect(row?.cap_listing).toBe(1);
        expect(row?.display_name).toBe("Rohlík.cz");
    });

    it("is idempotent — calling twice produces the same row", async () => {
        await syncShopsFromRegistry(db);
        const first = readShop("rohlik.cz");
        await syncShopsFromRegistry(db);
        const second = readShop("rohlik.cz");
        expect(second).toEqual(first as ShopRow);
    });
});
