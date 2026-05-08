import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { BenuClient } from "./BenuClient";
import type { BenuApiProduct } from "./BenuClient.types";

function readFixture(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/benu", rel), "utf8");
}

interface RouteSpec {
    match: string;
    method: "get" | "getText";
    response: unknown;
}

interface MockedClient {
    client: BenuClient;
    calls: Array<{ method: "get" | "getText"; url: string }>;
}

function buildClient(routes: RouteSpec[]): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new BenuClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "get", {
        value: async (path: string) => {
            calls.push({ method: "get", url: path });
            for (const r of routes) {
                if (r.method === "get" && path.includes(r.match)) {
                    return r.response;
                }
            }

            throw new Error(`No GET fixture for ${path}`);
        },
    });
    Object.defineProperty(client, "getText", {
        value: async (path: string) => {
            calls.push({ method: "getText", url: path });
            for (const r of routes) {
                if (r.method === "getText" && path.includes(r.match)) {
                    return r.response as string;
                }
            }

            throw new Error(`No HTML fixture for ${path}`);
        },
    });
    return { client, calls };
}

describe("BenuClient.listCategories", () => {
    it("parses div.main-menu__submenu links into Category[]", async () => {
        const home = readFixture("home.html");
        const { client } = buildClient([{ match: "https://www.benu.cz", method: "getText", response: home }]);

        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(2);
        for (const c of cats) {
            expect(typeof c.id).toBe("string");
            expect(typeof c.name).toBe("string");
            expect(c.url?.startsWith("https://www.benu.cz")).toBe(true);
        }
    });

    it("filters out '#' and '/' hrefs", async () => {
        const home = readFixture("home.html");
        const { client } = buildClient([{ match: "https://www.benu.cz", method: "getText", response: home }]);

        const cats = await client.listCategories();
        expect(cats.every((c) => c.id !== "#" && c.id !== "/")).toBe(true);
    });
});

describe("BenuClient.listCategory", () => {
    it("yields RawProducts from category-listing tiles", async () => {
        const listing = readFixture("category-listing.html");
        const { client } = buildClient([{ match: "leky-bez-receptu", method: "getText", response: listing }]);

        const out = [];
        for await (const p of client.listCategory({
            category: "/leky-bez-receptu",
            limit: 3,
        })) {
            out.push(p);
        }

        expect(out.length).toBe(3);
        for (const p of out) {
            expect(p.shopOrigin).toBe("benu.cz");
            expect(p.url.startsWith("https://www.benu.cz")).toBe(true);
            expect(p.name.length).toBeGreaterThan(0);
        }
    });

    it("captures originalPrice when product-box__price-old is present", async () => {
        const listing = readFixture("category-listing.html");
        const { client } = buildClient([{ match: "leky-bez-receptu", method: "getText", response: listing }]);

        const out = [];
        for await (const p of client.listCategory({ category: "/leky-bez-receptu", limit: 5 })) {
            out.push(p);
        }

        const paralen = out.find((p) => p.name.includes("Paralen"));
        expect(paralen).toBeDefined();
        expect(paralen?.currentPrice).toBe(79.9);
        expect(paralen?.originalPrice).toBe(99.9);
    });

    it("paginates by following nav.paging up to maxPage", async () => {
        const page1 = readFixture("category-listing.html");
        const page2 = readFixture("category-page2.html");
        const { client, calls } = buildClient([
            { match: "?page=2", method: "getText", response: page2 },
            { match: "leky-bez-receptu", method: "getText", response: page1 },
        ]);

        const seen: string[] = [];
        for await (const p of client.listCategory({ category: "/leky-bez-receptu", limit: 1000 })) {
            seen.push(p.url);
        }

        const visitedPage2 = calls.some((c) => c.url.includes("page=2"));
        expect(visitedPage2).toBe(true);
        // 3 (page 1) + 2 (page 2) = 5 minimum
        expect(seen.length).toBeGreaterThanOrEqual(5);
    });
});

describe("BenuClient.getProduct", () => {
    it("parses #snippet-productRichSnippet-richSnippet JSON-LD + secondary API for rrpPrice", async () => {
        const productHtml = readFixture("product-detail.html");
        const apiProduct = SafeJSON.parse(readFixture("api-base-product.json")) as BenuApiProduct;
        const { client } = buildClient([
            {
                match: "alavis-maxima-triple-blend-extra-silny-700-g",
                method: "getText",
                response: productHtml,
            },
            { match: "api/base/v1/products", method: "get", response: apiProduct },
        ]);

        const p = await client.getProduct({
            url: "https://www.benu.cz/alavis-maxima-triple-blend-extra-silny-700-g",
        });

        expect(p.shopOrigin).toBe("benu.cz");
        expect(p.name).toBe("Alavis Maxima Triple Blend Extra silný 700g");
        expect(p.itemId).toBe("BENU-300001");
        expect(p.currentPrice).toBe(1290);
        expect(p.originalPrice).toBe(1490);
        expect(p.imageUrl).toBe("https://www.benu.cz/img/alavis-maxima.jpg");
        expect(p.categoryPath).toEqual(["Doplňky stravy", "Klouby", "Alavis"]);
    });

    it("survives if the secondary API call fails", async () => {
        const productHtml = readFixture("product-detail.html");
        const { client } = buildClient([
            {
                match: "alavis-maxima",
                method: "getText",
                response: productHtml,
            },
        ]);

        const p = await client.getProduct({
            url: "https://www.benu.cz/alavis-maxima-triple-blend-extra-silny-700-g",
        });
        expect(p.name).toBeTruthy();
        expect(p.originalPrice).toBeUndefined();
    });
});

describe("BenuClient capabilities", () => {
    it("declares cap_ean=false (Benu identifier is SKU; identifierSUKL is drug code, not EAN)", () => {
        const sink = new MemoryHttpRequestSink();
        const client = new BenuClient({ sink });
        expect(client.capabilities.ean).toBe(false);
        expect(client.capabilities.live).toBe(true);
        expect(client.capabilities.history).toBe(true);
        expect(client.capabilities.listing).toBe(true);
        expect(client.capabilities.botProtection).toBe("none");
    });
});
