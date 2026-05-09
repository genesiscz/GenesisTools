import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { HornbachClient } from "./HornbachClient";

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/hornbach", rel), "utf8");
}

interface MockedClient {
    client: HornbachClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; html: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new HornbachClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    let pageMatchCount = 0;
    Object.defineProperty(client, "getText", {
        value: async (path: string) => {
            calls.push({ url: path });
            for (const r of routes) {
                if (path.includes(r.match)) {
                    if (r.match.includes("/c/zahrada")) {
                        pageMatchCount++;
                        if (pageMatchCount > 1) {
                            return "<html><body></body></html>";
                        }
                    }

                    return r.html;
                }
            }

            throw new Error(`No fixture for ${path}`);
        },
    });
    return { client, calls };
}

describe("HornbachClient.listCategories", () => {
    it("walks top-level [data-testid='product-category'] cards", async () => {
        const html = readHtml("home.html");
        const { client } = buildClient([{ match: "https://www.hornbach.cz/", html }]);
        const cats = await client.listCategories();
        expect(cats.length).toBe(2);
        expect(cats[0].name).toBe("Zahrada");
        expect(cats[0].url).toContain("hornbach.cz");
    });
});

describe("HornbachClient.listCategory", () => {
    it("yields RawProducts from a category page (extracted from window.__APOLLO_STATE__)", async () => {
        const html = readHtml("category-page1.html");
        const { client } = buildClient([{ match: "/c/zahrada", html }]);
        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "zahrada/SH00001", limit: 5 })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
        expect(out[0].shopOrigin).toBe("hornbach.cz");
        expect(out[0].itemId).toBe("12345");
        expect(out[0].name).toBe("Lopata na sníh");
        expect(out[0].currentPrice).toBe(399);
        expect(out[0].imageUrl).toContain("lopata.jpg");
        expect(out[0].categoryPath).toEqual(["Zahrada"]);
    });
});

describe("HornbachClient.getProduct", () => {
    it("parses a product detail page from Apollo state when present", async () => {
        const html = readHtml("product-detail.html");
        const { client } = buildClient([{ match: "/p/lopata-na-snih", html }]);
        const raw = await client.getProduct({
            url: "https://www.hornbach.cz/p/lopata-na-snih/12345/",
        });
        expect(raw.shopOrigin).toBe("hornbach.cz");
        expect(raw.itemId).toBe("12345");
        expect(raw.name).toBe("Lopata na sníh");
        expect(raw.currentPrice).toBe(399);
    });
});
