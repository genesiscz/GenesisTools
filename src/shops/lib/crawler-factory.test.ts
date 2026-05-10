import { describe, expect, it } from "bun:test";
import { ShopApiClient } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import { createCrawlerForShop } from "@app/shops/lib/crawler-factory";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

class FakeClient extends ShopApiClient {
    readonly shopOrigin: string;
    readonly displayName = "Fake";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: true,
        search: true,
        botProtection: "none",
    };

    constructor(origin: string) {
        super({ baseUrl: "https://fake.cz", rateLimitPerSecond: 1000 });
        this.shopOrigin = origin;
    }

    async getProduct(): Promise<RawProduct> {
        throw new Error("unused");
    }

    async *listCategory(_: ListingOptions): AsyncIterable<RawProduct> {}

    async listCategories(): Promise<Category[]> {
        return [];
    }

    parseUrl(url: string): { shopOrigin: string; slug: string; itemId?: string } {
        return { shopOrigin: this.shopOrigin, slug: url };
    }
}

const KNOWN_SHOPS = [
    "rohlik.cz",
    "kosik.cz",
    "kaufland.cz",
    "drmax.cz",
    "benu.cz",
    "itesco.cz",
    "dm.cz",
    "billa.cz",
    "lidl.cz",
    "tetadrogerie.cz",
    "albert.cz",
    "alza.cz",
    "notino.cz",
    "mall.cz",
    "mountfield.cz",
    "pilulka.cz",
    "knihydobrovsky.cz",
    "hornbach.cz",
    "mojadm.sk",
] as const;

describe("createCrawlerForShop", () => {
    it("returns a crawler for every supported shop origin", () => {
        const db = buildTestDatabase();
        try {
            for (const origin of KNOWN_SHOPS) {
                const crawler = createCrawlerForShop(new FakeClient(origin), db);
                expect(crawler).toBeDefined();
            }
        } finally {
            db.close();
        }
    });

    it("throws for an unknown shop origin", () => {
        const db = buildTestDatabase();
        try {
            expect(() => createCrawlerForShop(new FakeClient("never-heard.example"), db)).toThrow(
                /no crawler registered/
            );
        } finally {
            db.close();
        }
    });
});
