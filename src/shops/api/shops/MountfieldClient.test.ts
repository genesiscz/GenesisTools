import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { MountfieldClient } from "@app/shops/api/shops/MountfieldClient";

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/mountfield", rel), "utf8");
}

interface MockedClient {
    client: MountfieldClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; html: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new MountfieldClient({ sink, rateLimitPerSecond: 1000 });
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

describe("MountfieldClient.listCategory", () => {
    it("yields RawProducts from a category page", async () => {
        const html = readHtml("category-page1.html");
        const { client } = buildClient([{ match: "/travni-sekacky", html }]);
        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "travni-sekacky", limit: 5 })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
        expect(out[0].shopOrigin).toBe("mountfield.cz");
        expect(out[0].itemId).toBe("7300003");
        expect(typeof out[0].currentPrice).toBe("number");
        expect(out[0].currentPrice).toBe(15990);
        expect(out[0].originalPrice).toBe(17990);
        expect(out[0].categoryPath).toEqual(["Domů", "Travní sekačky"]);
    });

    it("respects opts.limit", async () => {
        const html = readHtml("category-page1.html");
        const { client } = buildClient([{ match: "/travni-sekacky", html }]);
        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "travni-sekacky", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBe(1);
    });

    it("recurses into .list-categories__item__block subcategories (BFS)", async () => {
        const hubHtml = `
            <html><body>
                <nav class="box-breadcrumb"><span class="box-breadcrumb__item">Předvýpis</span></nav>
                <a class="list-categories__item__block" href="/leaf-a"><h3>Leaf A</h3></a>
                <a class="list-categories__item__block" href="/leaf-b"><h3>Leaf B</h3></a>
            </body></html>`;
        const leafA = `
            <html><body>
                <div class="list-products__item__in">
                    <a class="list-products__item__block" href="/leaf-a-product-1001"></a>
                    <h2>Leaf A product 1</h2>
                    <span class="list-products__item__info__price__item--main">100 Kč</span>
                </div>
            </body></html>`;
        const leafB = `
            <html><body>
                <div class="list-products__item__in">
                    <a class="list-products__item__block" href="/leaf-b-product-2001"></a>
                    <h2>Leaf B product 1</h2>
                    <span class="list-products__item__info__price__item--main">200 Kč</span>
                </div>
            </body></html>`;
        const { client, calls } = buildClient([
            { match: "/predvypis", html: hubHtml },
            { match: "/leaf-a", html: leafA },
            { match: "/leaf-b", html: leafB },
        ]);

        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "predvypis", limit: 10 })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
        expect(out.map((p) => p.itemId).sort()).toEqual(["1001", "2001"]);
        // BFS visits hub then both leaves: 3 page fetches.
        expect(calls.length).toBe(3);
    });

    it("follows .in-paging__control__item--arrow-next pagination across pages", async () => {
        const page1 = `
            <html><body>
                <div class="list-products__item__in">
                    <a class="list-products__item__block" href="/p-1-3001"></a>
                    <h2>P1</h2>
                    <span class="list-products__item__info__price__item--main">10 Kč</span>
                </div>
                <a class="in-paging__control__item--arrow-next" href="/zahradni-technika?page=2">Next</a>
            </body></html>`;
        const page2 = `
            <html><body>
                <div class="list-products__item__in">
                    <a class="list-products__item__block" href="/p-2-3002"></a>
                    <h2>P2</h2>
                    <span class="list-products__item__info__price__item--main">20 Kč</span>
                </div>
            </body></html>`;
        const { client, calls } = buildClient([
            { match: "?page=2", html: page2 },
            { match: "/zahradni-technika", html: page1 },
        ]);

        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "zahradni-technika", limit: 10 })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
        expect(out.map((p) => p.itemId)).toEqual(["3001", "3002"]);
        expect(calls.length).toBe(2);
    });

    it("dedupes URLs so subcategory cycles don't loop forever", async () => {
        const looper = `
            <html><body>
                <a class="list-categories__item__block" href="/loop-a"><h3>A</h3></a>
                <a class="list-categories__item__block" href="/loop-b"><h3>B</h3></a>
            </body></html>`;
        // loop-a links back to loop-b, loop-b back to loop-a — BFS must not revisit.
        const loopA = `
            <html><body>
                <a class="list-categories__item__block" href="/loop-b"><h3>B</h3></a>
                <a class="list-categories__item__block" href="/loop-start"><h3>start</h3></a>
            </body></html>`;
        const loopB = `
            <html><body>
                <a class="list-categories__item__block" href="/loop-a"><h3>A</h3></a>
            </body></html>`;
        const { client, calls } = buildClient([
            { match: "/loop-start", html: looper },
            { match: "/loop-a", html: loopA },
            { match: "/loop-b", html: loopB },
        ]);

        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "loop-start", limit: 5 })) {
            out.push(p);
        }

        // No products anywhere — but we should visit each URL exactly once.
        expect(out.length).toBe(0);
        expect(calls.length).toBe(3);
    });
});

describe("MountfieldClient.getProduct", () => {
    it("parses a product detail page", async () => {
        const html = readHtml("product-detail.html");
        const { client } = buildClient([{ match: "akumulatorova-travni-sekacka", html }]);
        const raw = await client.getProduct({
            url: "https://www.mountfield.cz/akumulatorova-travni-sekacka-stiga-collector-548-ae-nh-7300003",
        });

        expect(raw.shopOrigin).toBe("mountfield.cz");
        expect(raw.itemId).toBe("7300003");
        expect(raw.name.toLowerCase()).toContain("sekačka");
    });
});

describe("MountfieldClient.listCategories", () => {
    it("walks home navigation", async () => {
        const html = readHtml("home.html");
        const { client } = buildClient([{ match: "https://www.mountfield.cz/", html }]);
        const cats = await client.listCategories();
        expect(cats.length).toBe(2);
        expect(cats[0].name).toBe("Travní sekačky");
    });
});
