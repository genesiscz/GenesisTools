import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { KnihyDobrovskyClient } from "./KnihyDobrovskyClient";

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/knihydobrovsky", rel), "utf8");
}

interface MockedClient {
    client: KnihyDobrovskyClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; html: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new KnihyDobrovskyClient({ sink, rateLimitPerSecond: 1000 });
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

describe("KnihyDobrovskyClient.listCategory", () => {
    it("yields RawProducts from a category page (data-productinfo cards)", async () => {
        const html = readHtml("category-page1.html");
        const { client } = buildClient([{ match: "/detska-literatura", html }]);
        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "detska-literatura", limit: 5 })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
        expect(out[0].shopOrigin).toBe("knihydobrovsky.cz");
        expect(out[0].itemId).toBe("1234567");
        expect(out[0].currentPrice).toBe(199);
        expect(out[0].originalPrice).toBe(299);
        expect(out[0].inStock).toBe(true);
    });
});

describe("KnihyDobrovskyClient.getProduct", () => {
    it("parses a product detail page", async () => {
        const html = readHtml("product-detail.html");
        const { client } = buildClient([{ match: "o-cervene-karkulce", html }]);
        const raw = await client.getProduct({
            url: "https://www.knihydobrovsky.cz/kniha/o-cervene-karkulce-2024-1234567",
        });
        expect(raw.shopOrigin).toBe("knihydobrovsky.cz");
        expect(raw.itemId).toBe("1234567");
    });
});

describe("KnihyDobrovskyClient.listCategories", () => {
    it("walks #main div.row-main li a", async () => {
        const html = readHtml("home.html");
        const { client } = buildClient([{ match: "https://www.knihydobrovsky.cz/", html }]);
        const cats = await client.listCategories();
        expect(cats.length).toBe(2);
        expect(cats[0].id).toBe("detska-literatura");
    });
});
