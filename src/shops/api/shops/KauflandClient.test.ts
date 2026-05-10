import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { KauflandClient } from "@app/shops/api/shops/KauflandClient";

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/kaufland", rel), "utf8");
}

interface MockedClient {
    client: KauflandClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; html: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new KauflandClient({ sink, rateLimitPerSecond: 1000 });
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

describe("KauflandClient.listCategories", () => {
    it("extracts top-level categories from home footer", async () => {
        const home = readHtml("home.html");
        const { client } = buildClient([{ match: "kaufland.cz/", html: home }]);

        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        expect(cats.every((c) => typeof c.url === "string" && c.url.startsWith("https://www.kaufland.cz/"))).toBe(true);
    });
});

describe("KauflandClient.listCategory", () => {
    it("yields products parsed from JSON-LD + article elements", async () => {
        const productPage = readHtml("category-with-products.html");
        const { client } = buildClient([{ match: "/category/", html: productPage }]);

        const out = [];
        for await (const item of client.listCategory({ category: "03832", limit: 50 })) {
            out.push(item);
        }

        expect(out.length).toBeGreaterThan(0);
        expect(out[0].shopOrigin).toBe("kaufland.cz");
        expect(typeof out[0].currentPrice).toBe("number");
    });

    it("excludes sponsored articles", async () => {
        const productPage = readHtml("category-with-products.html");
        const { client } = buildClient([{ match: "/category/", html: productPage }]);

        const out = [];
        for await (const item of client.listCategory({ category: "03832", limit: 50 })) {
            out.push(item);
        }

        expect(out.every((p) => !p.name.toLowerCase().includes("sponzorovaný"))).toBe(true);
    });

    it("captures originalPrice from price-note--rrp when discounted", async () => {
        const productPage = readHtml("category-with-products.html");
        const { client } = buildClient([{ match: "/category/", html: productPage }]);

        const out = [];
        for await (const item of client.listCategory({ category: "03832", limit: 50 })) {
            out.push(item);
        }

        const lipanek = out.find((p) => p.name.includes("Lipánek"));
        expect(lipanek).toBeDefined();
        expect(lipanek?.currentPrice).toBe(12.9);
        expect(lipanek?.originalPrice).toBe(15.9);
    });

    it("respects opts.limit", async () => {
        const productPage = readHtml("category-with-products.html");
        const { client } = buildClient([{ match: "/category/", html: productPage }]);

        const out = [];
        for await (const item of client.listCategory({ category: "03832", limit: 1 })) {
            out.push(item);
        }

        expect(out.length).toBe(1);
    });

    it("maps OutOfStock availability to inStock=false", async () => {
        const productPage = readHtml("category-with-products.html");
        const { client } = buildClient([{ match: "/category/", html: productPage }]);

        const out = [];
        for await (const item of client.listCategory({ category: "03832", limit: 50 })) {
            out.push(item);
        }

        const oos = out.find((p) => p.name.includes("Pribiňáček"));
        expect(oos?.inStock).toBe(false);
    });
});
