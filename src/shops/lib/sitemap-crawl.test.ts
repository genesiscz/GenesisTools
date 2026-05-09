import { afterEach, describe, expect, it } from "bun:test";
import { initShopRegistry } from "../api/registry-init";
import { ShopRegistry } from "../api/ShopRegistry";
import type { ShopApiClient } from "../api/ShopApiClient";
import type { RawProduct } from "../api/ShopApiClient.types";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { crawlFromSitemap } from "./sitemap-crawl";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    ShopRegistry.reset();
});

function mockFetch(routes: Record<string, string>): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const body = routes[url];
        if (!body) {
            return new Response("not mocked", { status: 404 });
        }

        return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
    }) as typeof fetch;
}

async function makeDb(): Promise<ShopsDatabase> {
    const db = new ShopsDatabase(":memory:");
    await db.upsertShop({
        origin: "rohlik.cz",
        display_name: "Rohlík.cz",
        currency: "CZK",
        cap_live: 1,
        cap_history: 1,
        cap_listing: 1,
        cap_ean: 1,
        cap_search: 1,
        bot_protection: "none",
    });
    return db;
}

class FakeRohlikClient {
    readonly shopOrigin = "rohlik.cz";
    readonly displayName = "Rohlík.cz (test)";
    readonly currency = "CZK";
    readonly capabilities = {
        live: true,
        history: true,
        listing: true,
        ean: true,
        search: false,
        botProtection: "none" as const,
    };

    listByIdsCalls: string[][] = [];

    async *listByIds(ids: string[]): AsyncIterable<RawProduct> {
        this.listByIdsCalls.push([...ids]);
        for (const id of ids) {
            yield {
                shopOrigin: this.shopOrigin,
                slug: id,
                itemId: id,
                url: `https://www.rohlik.cz/${id}-fake-product`,
                name: `Product ${id}`,
                currentPrice: 12.5,
                observedAt: new Date(),
                raw: { id },
            };
        }
    }

    async getProduct(): Promise<RawProduct> {
        throw new Error("not used in this test");
    }

    async *listCategory(): AsyncIterable<RawProduct> {
        // not used
    }

    async listCategories(): Promise<[]> {
        return [];
    }
}

describe("crawlFromSitemap", () => {
    it("walks sitemap, dedupes against DB, batches ids through listByIds, persists rows", async () => {
        mockFetch({
            "https://www.rohlik.cz/sitemap.xml": `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://www.rohlik.cz/sitemap_products.xml</loc></sitemap></sitemapindex>`,
            "https://www.rohlik.cz/sitemap_products.xml": `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.rohlik.cz/1001-known-product</loc></url>
<url><loc>https://www.rohlik.cz/2002-fresh-product-a</loc></url>
<url><loc>https://www.rohlik.cz/3003-fresh-product-b</loc></url>
</urlset>`,
        });

        const db = await makeDb();
        // Pre-seed one product so onlyNew=true skips it.
        await db.upsertProductPending({
            shopOrigin: "rohlik.cz",
            slug: "1001",
            url: "https://www.rohlik.cz/1001-known-product",
            name: "Known",
            observedAt: new Date(),
            raw: {},
        });

        // Wire a fake client into the singleton registry.
        initShopRegistry();
        const fake = new FakeRohlikClient();
        ShopRegistry.get().register(fake as unknown as ShopApiClient);

        const result = await crawlFromSitemap({ shopOrigin: "rohlik.cz", db });

        expect(result.shopOrigin).toBe("rohlik.cz");
        expect(result.discovered).toBe(2);
        expect(result.fetched).toBe(2);
        expect(result.persisted).toBe(2);
        expect(result.pricesRecorded).toBe(2);
        expect(fake.listByIdsCalls).toEqual([["2002", "3003"]]);

        // DB now has 3 products (1 pre-seeded + 2 new).
        const total = db
            .raw()
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM products WHERE shop_origin='rohlik.cz'")
            .get();
        expect(total?.n).toBe(3);

        db.close();
    });

    it("rejects shop without listByIds support", async () => {
        const db = await makeDb();
        mockFetch({
            "https://www.rohlik.cz/sitemap.xml": `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`,
        });
        initShopRegistry();

        // RohlikClient has listByIds, so use a stub that doesn't.
        class NoBulk {
            readonly shopOrigin = "rohlik.cz";
            readonly displayName = "x";
            readonly currency = "CZK";
            readonly capabilities = {
                live: true,
                history: false,
                listing: false,
                ean: false,
                search: false,
                botProtection: "none" as const,
            };
            async getProduct(): Promise<RawProduct> {
                throw new Error("no");
            }
            async *listCategory(): AsyncIterable<RawProduct> {}
            async listCategories(): Promise<[]> {
                return [];
            }
        }

        ShopRegistry.get().register(new NoBulk() as unknown as ShopApiClient);

        await expect(crawlFromSitemap({ shopOrigin: "rohlik.cz", db })).rejects.toThrow(/listByIds/);

        db.close();
    });
});
