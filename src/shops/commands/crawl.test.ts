import { beforeEach, describe, expect, it } from "bun:test";
import { __resetInitState, initShopRegistry } from "@app/shops/api/registry-init";
import { ShopApiClient } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import { ShopRegistry } from "@app/shops/api/ShopRegistry";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { runCrawlCommand } from "@app/shops/commands/crawl";

class FakeRohlikClient extends ShopApiClient {
    readonly shopOrigin = "rohlik.cz";
    readonly displayName = "Fake Rohlik";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: true,
        search: true,
        botProtection: "none",
    };

    constructor() {
        super({ baseUrl: "https://fake.cz", rateLimitPerSecond: 1000 });
    }

    async getProduct(): Promise<RawProduct> {
        throw new Error("unused");
    }

    async *listCategory(_: ListingOptions): AsyncIterable<RawProduct> {
        yield {
            shopOrigin: "rohlik.cz",
            slug: "1",
            itemId: "1",
            url: "https://www.rohlik.cz/1-test",
            name: "Test product",
            currentPrice: 99,
            observedAt: new Date(),
            raw: {},
        };
    }

    async listCategories(): Promise<Category[]> {
        return [{ id: "cat-1", name: "Cat" }];
    }

    parseUrl(url: string): { shopOrigin: string; slug: string; itemId?: string } {
        return { shopOrigin: "rohlik.cz", slug: url, itemId: url };
    }
}

// Flip init state to "already initialized" so runCrawlCommand's initShopRegistry()
// becomes a no-op and our pre-registered fake survives.
function lockRegistryWithFakes(clients: Array<ShopApiClient>): void {
    ShopRegistry.reset();
    __resetInitState();
    initShopRegistry(); // populates the singleton with real clients + flips init flag
    ShopRegistry.reset();
    for (const client of clients) {
        ShopRegistry.get().register(client);
    }
}

describe("runCrawlCommand", () => {
    beforeEach(() => {
        ShopRegistry.reset();
        __resetInitState();
    });

    it("returns successful CrawlResult for known shop", async () => {
        const db = buildTestDatabase();
        try {
            lockRegistryWithFakes([new FakeRohlikClient()]);

            const result = await runCrawlCommand({ shop: "rohlik.cz", limit: 5, db });
            expect(result.status).toBe("completed");
            expect(result.productsSeen).toBe(1);
        } finally {
            db.close();
        }
    });

    it("throws for unknown shop", async () => {
        const db = buildTestDatabase();
        try {
            lockRegistryWithFakes([]);

            await expect(runCrawlCommand({ shop: "unknown.cz", db })).rejects.toThrow(/unknown shop/i);
        } finally {
            db.close();
        }
    });
});
