import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { NotinoClient } from "./NotinoClient";

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/notino", rel), "utf8");
}

interface MockedClient {
    client: NotinoClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; html: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new NotinoClient({ sink, rateLimitPerSecond: 1000 });
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

describe("NotinoClient.getProduct", () => {
    it("parses Apollo-cache product detail into RawProduct", async () => {
        const html = readHtml("product-detail.html");
        const { client } = buildClient([{ match: "coco-mademoiselle", html }]);

        const raw = await client.getProduct({
            url: "https://www.notino.cz/chanel/coco-mademoiselle-parfemovana-voda-pro-zeny/",
        });

        expect(raw.shopOrigin).toBe("notino.cz");
        expect(raw.itemId).toBe("12345");
        expect(raw.brand).toBe("Chanel");
        expect(raw.name).toContain("Coco Mademoiselle");
        expect(raw.currentPrice).toBe(2890);
        expect(raw.originalPrice).toBe(3290);
        expect(raw.url).toContain("notino.cz");
    });

    it("requires opts.url", async () => {
        const { client } = buildClient([]);
        await expect(client.getProduct({ slug: "x" })).rejects.toThrow(/requires opts.url/);
    });
});

describe("NotinoClient.listCategory", () => {
    it("yields RawProducts from a category page", async () => {
        const cat = readHtml("category-page1.html");
        const detail = readHtml("product-detail.html");
        const { client } = buildClient([
            { match: "/damske-parfemy/", html: cat },
            { match: "/chanel/coco-mademoiselle", html: detail },
            { match: "/dior/jadore", html: detail },
        ]);

        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "damske-parfemy", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBeGreaterThan(0);
        expect(out[0].shopOrigin).toBe("notino.cz");
    });
});

describe("NotinoClient.listCategories", () => {
    it("walks the main-menu-state JSON to enumerate top categories", async () => {
        const home = readHtml("home.html");
        const { client } = buildClient([{ match: "https://www.notino.cz/", html: home }]);

        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        expect(cats[0].url).toContain("notino.cz");
    });
});
