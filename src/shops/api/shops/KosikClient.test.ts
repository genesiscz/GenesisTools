import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KosikClient } from "@app/shops/api/shops/KosikClient";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { SafeJSON } from "@app/utils/json";

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

    it("recursively walks subCategories to load more products", async () => {
        const parent = readFixture<{ products?: { items: unknown[] }; subCategories?: unknown[] }>(
            "listing-pekarna.json"
        );
        const child = readFixture("listing-page2.json");
        const empty = { products: { items: [] }, subCategories: [] };
        const { client, calls } = buildClient([
            { match: "slug=c1028-slane-pecivo", response: child },
            { match: "slug=c1026-pekarna-a-cukrarna", response: parent },
            { match: "/api/front/page/products", response: empty },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const item of client.listCategory({ category: "c1026-pekarna-a-cukrarna", limit: 200 })) {
            out.push(item);
        }

        expect(calls.some((c) => c.url.includes("slug=c1028-slane-pecivo"))).toBe(true);
        expect(out.length).toBeGreaterThan(0);
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

    it("substitutes WIDTHxHEIGHT placeholder in image URLs", async () => {
        const listing = {
            title: "Test",
            products: {
                items: [
                    {
                        id: 99,
                        name: "Bagetka",
                        url: "/p99-bagetka",
                        price: 12,
                        image: "https://static-new.kosik.cz/images/thumbs/dw/WIDTHxHEIGHTx1_dw0pt9sinm99.jpg",
                    },
                ],
            },
        };
        const { client } = buildClient([{ match: "/api/front/page/products", response: listing }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "x", limit: 1 })) {
            out.push(p);
        }

        expect(out[0].imageUrl).toBe("https://static-new.kosik.cz/images/thumbs/dw/200x200x1_dw0pt9sinm99.jpg");
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
