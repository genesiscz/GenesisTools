import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { RohlikClient } from "@app/shops/api/shops/RohlikClient";

function readFixture<T>(relPath: string): T {
    const full = join(import.meta.dir, "__fixtures__/rohlik", relPath);
    return SafeJSON.parse(readFileSync(full, "utf8")) as T;
}

interface MockedClient {
    client: RohlikClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; response: unknown }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new RohlikClient({ sink, rateLimitPerSecond: 1000 });
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

describe("RohlikClient.getProduct", () => {
    it("maps fixture batch product into RawProduct", async () => {
        const productsBatch = readFixture("products-batch.json");
        const pricesBatch = readFixture("products-prices-batch.json");
        const flat = readFixture("flat-navigation.json");
        const { client } = buildClient([
            { match: "/api/v1/products/prices", response: pricesBatch },
            { match: "/api/v1/products", response: productsBatch },
            { match: "/navigation/flat.json", response: flat },
        ]);

        const raw = await client.getProduct({ slug: "1415703" });

        expect(raw.shopOrigin).toBe("rohlik.cz");
        expect(raw.slug).toBe("1415703");
        expect(raw.itemId).toBe("1415703");
        expect(raw.url).toContain("rohlik.cz/1415703");
        expect(raw.name.length).toBeGreaterThan(0);
        expect(raw.observedAt).toBeInstanceOf(Date);
        expect(typeof raw.currentPrice).toBe("number");
    });
});

describe("RohlikClient mapping rules", () => {
    it("constructs canonical URL '<id>-<slug>'", async () => {
        const productsBatch = readFixture("products-batch.json");
        const pricesBatch = readFixture("products-prices-batch.json");
        const flat = readFixture("flat-navigation.json");
        const { client } = buildClient([
            { match: "/api/v1/products/prices", response: pricesBatch },
            { match: "/api/v1/products", response: productsBatch },
            { match: "/navigation/flat.json", response: flat },
        ]);

        const raw = await client.getProduct({ slug: "1415703" });
        expect(raw.url).toMatch(/^https:\/\/www\.rohlik\.cz\/1415703-/);
    });

    it("returns originalPrice for sale-type discount entries", async () => {
        const productsBatch = [
            {
                id: 99,
                name: "Test",
                slug: "test",
            },
        ];
        const pricesBatch = [
            {
                productId: 99,
                price: { amount: 100 },
                sales: [{ type: "sale", price: { amount: 80 } }],
            },
        ];
        const { client } = buildClient([
            { match: "/api/v1/products/prices", response: pricesBatch },
            { match: "/api/v1/products", response: productsBatch },
        ]);

        const raw = await client.getProduct({ slug: "99" });
        expect(raw.currentPrice).toBe(80);
        expect(raw.originalPrice).toBe(100);
    });

    it("does not set originalPrice for silent sales", async () => {
        const productsBatch = [{ id: 1, name: "X", slug: "x" }];
        const pricesBatch = [
            {
                productId: 1,
                price: { amount: 50 },
                sales: [{ type: "sale", silent: true, price: { amount: 40 } }],
            },
        ];
        const { client } = buildClient([
            { match: "/api/v1/products/prices", response: pricesBatch },
            { match: "/api/v1/products", response: productsBatch },
        ]);

        const raw = await client.getProduct({ slug: "1" });
        expect(raw.currentPrice).toBe(40);
        expect(raw.originalPrice).toBeUndefined();
    });
});

describe("RohlikClient.listCategory", () => {
    it("paginates and yields RawProducts", async () => {
        const count = readFixture("category-count.json");
        const productsPage = readFixture("category-products-page0.json");
        const productsBatch = readFixture("products-batch.json");
        const pricesBatch = readFixture("products-prices-batch.json");
        const flat = readFixture("flat-navigation.json");
        const { client } = buildClient([
            { match: "/products/count", response: count },
            { match: "/api/v1/categories/normal/300101000/products?page=0", response: productsPage },
            { match: "/api/v1/products/prices", response: pricesBatch },
            { match: "/api/v1/products", response: productsBatch },
            { match: "/navigation/flat.json", response: flat },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const item of client.listCategory({ category: "300101000", limit: 5 })) {
            out.push(item);
            if (out.length >= 5) {
                break;
            }
        }

        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(5);
        expect(out[0].shopOrigin).toBe("rohlik.cz");
    });
});

describe("RohlikClient.listCategories", () => {
    it("flattens flat-navigation tree to Category[]", async () => {
        const flat = readFixture("flat-navigation.json");
        const { client } = buildClient([{ match: "/navigation/flat.json", response: flat }]);

        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        expect(cats.every((c) => typeof c.id === "string" && c.name.length > 0)).toBe(true);
    });
});

describe("RohlikClient categoryPath enrichment", () => {
    it("resolves mainCategoryId into a breadcrumb path on toRawProduct", async () => {
        const productsBatch = readFixture("products-batch.json");
        const pricesBatch = readFixture("products-prices-batch.json");
        const flat = readFixture("flat-navigation.json");
        const { client, calls } = buildClient([
            { match: "/api/v1/products/prices", response: pricesBatch },
            { match: "/api/v1/products", response: productsBatch },
            { match: "/navigation/flat.json", response: flat },
        ]);

        const raw = await client.getProduct({ slug: "1415703" });

        expect(raw.categoryPath).toBeDefined();
        expect(raw.categoryPath?.length ?? 0).toBeGreaterThan(0);
        expect(raw.categoryPath?.every((c) => typeof c === "string" && c.length > 0)).toBe(true);

        // Subsequent lookups reuse the cached navigation tree — only one
        // /navigation/flat.json call across N products.
        const navCalls = calls.filter((c) => c.url.includes("/navigation/flat.json")).length;
        expect(navCalls).toBe(1);
    });
});
