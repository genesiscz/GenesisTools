import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { RawProduct } from "../api/ShopApiClient.types";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { syncShopSitemap } from "./sitemap-sync";

const realFetch = globalThis.fetch;

async function makeDb(): Promise<ShopsDatabase> {
    const db = new ShopsDatabase(":memory:");
    await db.upsertShop({
        origin: "kosik.cz",
        display_name: "Košík.cz",
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

afterAll(() => {
    globalThis.fetch = realFetch;
});

describe("syncShopSitemap (kosik)", () => {
    beforeAll(() => {
        mockFetch({
            "https://www.kosik.cz/sitemap.xml": `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://www.kosik.cz/products_01.xml</loc></sitemap>
<sitemap><loc>https://www.kosik.cz/categories.xml</loc></sitemap>
</sitemapindex>`,
            "https://www.kosik.cz/products_01.xml": `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.kosik.cz/p708210-known-product</loc></url>
<url><loc>https://www.kosik.cz/p999999-new-product-a</loc></url>
<url><loc>https://www.kosik.cz/p888888-new-product-b</loc></url>
<url><loc>https://www.kosik.cz/c1046-some-category</loc></url>
</urlset>`,
            "https://www.kosik.cz/categories.xml": `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.kosik.cz/c1-x</loc></url></urlset>`,
        });
    });

    it("diffs sitemap URLs against products table by slug", async () => {
        const db = await makeDb();
        const known: RawProduct = {
            shopOrigin: "kosik.cz",
            slug: "p708210-known-product",
            url: "https://www.kosik.cz/p708210-known-product",
            name: "Known",
            observedAt: new Date(),
            raw: {},
        };
        await db.upsertProductPending(known);

        const result = await syncShopSitemap({ shopOrigin: "kosik.cz", db });
        expect(result.discovered).toBe(3);
        expect(result.knownInDb).toBe(1);
        expect(result.newUrls.sort()).toEqual([
            "https://www.kosik.cz/p888888-new-product-b",
            "https://www.kosik.cz/p999999-new-product-a",
        ]);
        expect(result.shopOrigin).toBe("kosik.cz");
        db.close();
    });

    it("throws on unknown shop", async () => {
        const db = await makeDb();
        await expect(syncShopSitemap({ shopOrigin: "no-such.shop", db })).rejects.toThrow(/sitemap strategy/);
        db.close();
    });
});
