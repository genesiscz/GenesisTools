import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { describe, expect, it } from "bun:test";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { KosikClient } from "./KosikClient";

function readFixture<T>(relPath: string): T {
    const full = join(import.meta.dir, "__fixtures__/kosik", relPath);
    return SafeJSON.parse(readFileSync(full, "utf8")) as T;
}

interface MockedClient {
    client: KosikClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; response: unknown }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new KosikClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "get", {
        value: async (path: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params
                ? `?${new URLSearchParams(options.params as Record<string, string>).toString()}`
                : "";
            const fullPath = `${path}${params}`;
            calls.push({ url: fullPath });
            for (const r of routes) {
                if (fullPath.includes(r.match)) {
                    return r.response;
                }
            }

            throw new Error(`No fixture for ${fullPath}`);
        },
    });
    return { client, calls };
}

describe("KosikClient.listCategory", () => {
    it("yields products from a single page", async () => {
        const listing = readFixture("listing-potraviny.json");
        const { client } = buildClient([{ match: "/api/front/page/products", response: listing }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const item of client.listCategory({ category: "c2835-rohliky", limit: 50 })) {
            out.push(item);
        }

        expect(out.length).toBeGreaterThan(0);
        expect(out.every((p) => p.shopOrigin === "kosik.cz")).toBe(true);
        expect(out.every((p) => typeof p.url === "string" && p.url.includes("kosik.cz"))).toBe(true);
    });

    it("paginates via offset using totalCount", async () => {
        const page1 = readFixture<{ totalCount?: number; products?: { items: unknown[] } }>("listing-pekarna.json");
        const page2 = readFixture("listing-page2.json");
        const { client, calls } = buildClient([
            { match: "offset=30", response: page2 },
            { match: "/api/front/page/products", response: page1 },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const item of client.listCategory({ category: "c1026-pekarna-a-cukrarna", limit: 60 })) {
            out.push(item);
        }

        expect(calls.some((c) => c.url.includes("offset=30"))).toBe(true);
        expect(out.length).toBeGreaterThan(30);
    });

    it("respects opts.limit even with more pages available", async () => {
        const page1 = readFixture("listing-pekarna.json");
        const { client } = buildClient([{ match: "/api/front/page/products", response: page1 }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const item of client.listCategory({ category: "c1026-pekarna-a-cukrarna", limit: 5 })) {
            out.push(item);
        }

        expect(out.length).toBe(5);
    });
});

describe("KosikClient.listCategories", () => {
    it("flattens recursive subcategories", async () => {
        const menu = readFixture("menu-main.json");
        const { client } = buildClient([{ match: "/api/front/menu/main", response: menu }]);

        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        expect(cats.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
        expect(cats.every((c) => c.name.length > 0)).toBe(true);
    });
});

describe("KosikClient mapping rules", () => {
    it("maps a product with recommendedPrice to originalPrice when discounted", async () => {
        const listing = {
            title: "Test",
            breadcrumbs: [{ name: "Test" }],
            products: {
                items: [
                    {
                        id: 1,
                        name: "Product",
                        url: "/p1234-product",
                        brand: "Brand",
                        price: 80,
                        recommendedPrice: 100,
                        productQuantity: { value: 500, unit: "g" },
                    },
                ],
            },
        };
        const { client } = buildClient([{ match: "/api/front/page/products", response: listing }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "x", limit: 1 })) {
            out.push(p);
        }

        expect(out[0].currentPrice).toBe(80);
        expect(out[0].originalPrice).toBe(100);
        expect(out[0].brand).toBe("Brand");
        expect(out[0].unitAmount).toBe(500);
    });

    it("maps inStock to false when firstOrderDay is set", async () => {
        const listing = {
            title: "Test",
            products: {
                items: [
                    {
                        id: 2,
                        name: "Pre-order",
                        url: "/p222-x",
                        price: 50,
                        firstOrderDay: "2026-12-01",
                    },
                ],
            },
        };
        const { client } = buildClient([{ match: "/api/front/page/products", response: listing }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "x", limit: 1 })) {
            out.push(p);
        }

        expect(out[0].inStock).toBe(false);
    });
});
