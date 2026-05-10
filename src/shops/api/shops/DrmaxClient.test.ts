import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { DrmaxClient } from "@app/shops/api/shops/DrmaxClient";

function readFixture(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/drmax", rel), "utf8");
}

interface MockedClient {
    client: DrmaxClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; response: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new DrmaxClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "getText", {
        value: async (path: string) => {
            calls.push({ url: path });
            for (const r of routes) {
                if (path.includes(r.match)) {
                    return r.response;
                }
            }

            throw new Error(`No HTML fixture for ${path}`);
        },
    });
    return { client, calls };
}

describe("DrmaxClient.listCategories", () => {
    it("parses the sitemap into category entries", async () => {
        const xml = readFixture("sitemap-kategorie.xml");
        const { client, calls } = buildClient([{ match: "sitemap/kategorie.xml", response: xml }]);

        const cats = await client.listCategories();

        expect(cats.length).toBeGreaterThan(2);
        expect(cats.every((c) => typeof c.url === "string" && c.url.startsWith("https://"))).toBe(true);
        expect(cats.every((c) => typeof c.id === "string" && c.id.startsWith("/"))).toBe(true);
        expect(calls.length).toBe(1);
        expect(calls[0]!.url).toContain("sitemap/kategorie.xml");
    });
});

describe("DrmaxClient.listCategory", () => {
    it("yields RawProducts from a category page", async () => {
        const page1 = readFixture("category-page1.html");
        const page2 = readFixture("category-page2.html");
        const { client } = buildClient([
            { match: "page=2", response: page2 },
            { match: "category-page1", response: page1 },
            { match: "leky-bez-receptu", response: page1 },
        ]);

        const out = [];
        for await (const item of client.listCategory({
            category: "https://www.drmax.cz/category-page1",
            limit: 50,
        })) {
            out.push(item);
        }

        expect(out.length).toBeGreaterThan(0);
        for (const product of out) {
            expect(product.shopOrigin).toBe("drmax.cz");
            expect(product.url.includes("drmax.cz")).toBe(true);
            expect(product.name.length).toBeGreaterThan(0);
            if (product.currentPrice != null) {
                expect(product.currentPrice).toBeGreaterThan(0);
            }
        }
    });

    it("captures originalPrice when product has tile__price__before", async () => {
        const page1 = readFixture("category-page1.html");
        const page2 = readFixture("category-page2.html");
        const { client } = buildClient([
            { match: "page=2", response: page2 },
            { match: "category-page1", response: page1 },
            { match: "leky-bez-receptu", response: page1 },
        ]);

        const out = [];
        for await (const item of client.listCategory({
            category: "https://www.drmax.cz/category-page1",
            limit: 50,
        })) {
            out.push(item);
        }

        const paralen = out.find((p) => p.name.includes("Paralen"));
        expect(paralen).toBeDefined();
        expect(paralen?.currentPrice).toBe(99.9);
        expect(paralen?.originalPrice).toBe(129.9);
    });

    it("flips inStock=false when .product__out-of-stock is present", async () => {
        const page1 = readFixture("category-page1.html");
        const page2 = readFixture("category-page2.html");
        const { client } = buildClient([
            { match: "page=2", response: page2 },
            { match: "category-page1", response: page1 },
            { match: "leky-bez-receptu", response: page1 },
        ]);

        const out = [];
        for await (const item of client.listCategory({
            category: "https://www.drmax.cz/category-page1",
            limit: 50,
        })) {
            out.push(item);
        }

        const panadol = out.find((p) => p.name.includes("Panadol"));
        expect(panadol?.inStock).toBe(false);
    });

    it("paginates by following .page-next a", async () => {
        const page1 = readFixture("category-page1.html");
        const page2 = readFixture("category-page2.html");
        const { client, calls } = buildClient([
            { match: "page=2", response: page2 },
            { match: "category-page1", response: page1 },
            { match: "leky-bez-receptu?page=2", response: page2 },
            { match: "leky-bez-receptu", response: page1 },
        ]);

        const seen: string[] = [];
        for await (const item of client.listCategory({
            category: "https://www.drmax.cz/category-page1",
            limit: 200,
        })) {
            seen.push(item.url);
        }

        expect(seen.length).toBeGreaterThan(0);
        const visitedPage2 = calls.some((c) => c.url.includes("page=2"));
        expect(visitedPage2).toBe(true);
        expect(seen.length).toBeGreaterThanOrEqual(4);
    });

    it("respects opts.limit", async () => {
        const page1 = readFixture("category-page1.html");
        const { client } = buildClient([{ match: "category-page1", response: page1 }]);

        const out = [];
        for await (const item of client.listCategory({
            category: "https://www.drmax.cz/category-page1",
            limit: 2,
        })) {
            out.push(item);
        }

        expect(out.length).toBe(2);
    });
});

describe("DrmaxClient.getProduct", () => {
    it("parses JSON-LD <script type='application/ld+json'> on the product detail page", async () => {
        const html = `<!DOCTYPE html><html><body>
<script type="application/ld+json">
{"@type":"Product","name":"Paralen Grip 12 tbl","image":"https://www.drmax.cz/img/x.jpg",
"offers":{"@type":"Offer","price":89.9,"priceCurrency":"CZK","availability":"https://schema.org/InStock"},
"gtin13":"8594040891234","sku":"DRMAX-12345"}
</script>
<ol class="breadcrumb"><li><a>Léky</a></li><li><a>Bolest</a></li></ol>
</body></html>`;
        const { client } = buildClient([{ match: "drmax.cz/cz/produkt/paralen-grip", response: html }]);

        const p = await client.getProduct({ url: "https://www.drmax.cz/cz/produkt/paralen-grip-12tbl" });
        expect(p.shopOrigin).toBe("drmax.cz");
        expect(p.name).toBe("Paralen Grip 12 tbl");
        expect(p.currentPrice).toBe(89.9);
        expect(p.imageUrl).toBe("https://www.drmax.cz/img/x.jpg");
        expect(p.inStock).toBe(true);
        expect(p.itemId).toBe("DRMAX-12345");
        expect(p.categoryPath).toEqual(["Léky", "Bolest"]);
        // gtin13 is in the JSON-LD but NOT copied into RawProduct.ean (cap_ean=false).
        expect(p.ean).toBeUndefined();
    });

    it("throws if no JSON-LD Product block is found", async () => {
        const html = `<!DOCTYPE html><html><body><h1>Página de error</h1></body></html>`;
        const { client } = buildClient([{ match: "/cz/missing", response: html }]);
        await expect(client.getProduct({ url: "https://www.drmax.cz/cz/missing" })).rejects.toThrow(
            /no JSON-LD Product/
        );
    });
});

describe("DrmaxClient capabilities", () => {
    it("declares cap_ean=false (Drmax meta is shop SKU, not EAN)", () => {
        const sink = new MemoryHttpRequestSink();
        const client = new DrmaxClient({ sink });
        expect(client.capabilities.ean).toBe(false);
        expect(client.capabilities.live).toBe(true);
        expect(client.capabilities.history).toBe(true);
        expect(client.capabilities.listing).toBe(true);
        expect(client.capabilities.botProtection).toBe("none");
    });
});
