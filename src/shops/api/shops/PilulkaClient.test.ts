import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { PilulkaClient } from "./PilulkaClient";

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/pilulka", rel), "utf8");
}

interface MockedClient {
    client: PilulkaClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; html: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new PilulkaClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "getText", {
        value: async (path: string) => {
            calls.push({ url: path });
            for (const r of routes) {
                if (path.includes(r.match)) {
                    return r.html;
                }
            }

            throw new Error(`No fixture for ${path}`);
        },
    });
    return { client, calls };
}

describe("PilulkaClient.getProduct", () => {
    it("parses JSON-LD product blob into RawProduct", async () => {
        const html = readHtml("product-detail.html");
        const { client } = buildClient([{ match: "jamieson", html }]);
        const raw = await client.getProduct({
            url: "https://www.pilulka.cz/jamieson-vitamin-c-1000-mg-100-tablet",
        });

        expect(raw.shopOrigin).toBe("pilulka.cz");
        expect(raw.itemId).toBe("123456");
        expect(raw.currentPrice).toBe(299);
        expect(raw.inStock).toBe(true);
        expect(raw.name).toContain("Vitamin C");
        expect(raw.categoryPath).toEqual(["Vitaminy", "Vitamin C"]);
    });
});

describe("PilulkaClient.listCategory", () => {
    it("yields RawProducts using the .product-list__item selector", async () => {
        const cat = readHtml("category-page1.html");
        const detail = readHtml("product-detail.html");
        const { client, calls } = buildClient([
            { match: "/akce-a-slevy", html: cat },
            { match: "jamieson", html: detail },
            { match: "/another-product", html: detail },
        ]);
        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "akce-a-slevy", limit: 5 })) {
            out.push(p);
        }

        // Fixture has 3 .product-list__item nodes but two share a slug — expect 2 unique products.
        expect(out.length).toBe(2);
        expect(out[0].shopOrigin).toBe("pilulka.cz");
        // First detail fetch should be the deduplicated jamieson URL, not the bare brand link.
        expect(calls.some((c) => c.url.endsWith("/jamieson-vitamin-c-1000-mg-100-tablet"))).toBe(true);
    });

    it("respects opts.limit before walking pagination", async () => {
        const cat = readHtml("category-page1.html");
        const detail = readHtml("product-detail.html");
        const { client } = buildClient([
            { match: "/akce-a-slevy", html: cat },
            { match: "jamieson", html: detail },
            { match: "/another-product", html: detail },
        ]);
        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "akce-a-slevy", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBe(1);
    });
});

describe("PilulkaClient.listCategories", () => {
    it("walks .menu__href anchors", async () => {
        const home = readHtml("home.html");
        const { client } = buildClient([{ match: "https://www.pilulka.cz/", html: home }]);
        const cats = await client.listCategories();
        expect(cats.length).toBe(2);
        expect(cats[0].name).toContain("Vitamíny");
    });
});
