import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClientError } from "@app/utils/api/ApiClient";
import { SafeJSON } from "@app/utils/json";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { DmClient } from "@app/shops/api/shops/DmClient";

function readFixture<T>(rel: string): T {
    const full = join(import.meta.dir, "__fixtures__/dm", rel);
    return SafeJSON.parse(readFileSync(full, "utf8")) as T;
}

interface MockedClient {
    client: DmClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; response: unknown }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new DmClient({ sink, rateLimitPerSecond: 1000 });
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

describe("DmClient.listCategories", () => {
    it("flattens navigation tree to Category[]", async () => {
        const nav = readFixture("navigation.json");
        const { client } = buildClient([{ match: "view=navigation", response: nav }]);
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        expect(cats.every((c) => typeof c.id === "string" && c.name.length > 0)).toBe(true);
        expect(cats.some((c) => c.id.startsWith("dekorativni-kosmetika"))).toBe(true);
    });
});

describe("DmClient.listCategory", () => {
    it("paginates and yields RawProducts (page0 + page1)", async () => {
        const meta = {
            mainData: [
                {
                    type: "products",
                    query: { queryTerms: "", filters: "allCategories.id:010101" },
                },
            ],
        };
        const page0 = readFixture("product-listing-page0.json");
        const page1 = readFixture("product-listing-page1.json");
        const { client } = buildClient([
            { match: "currentPage=1", response: page1 },
            { match: "currentPage=0", response: page0 },
            { match: "/dekorativni-kosmetika/oci/rasenky", response: meta },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const item of client.listCategory({
            category: "dekorativni-kosmetika/oci/rasenky",
            limit: 50,
        })) {
            out.push(item);
        }

        expect(out.length).toBeGreaterThan(0);
        expect(out.every((p) => p.shopOrigin === "dm.cz")).toBe(true);
    });

    it("populates EAN from gtin (only Phase-2 shop with real EANs)", async () => {
        const meta = {
            mainData: [
                {
                    type: "products",
                    query: { queryTerms: "", filters: "allCategories.id:010101" },
                },
            ],
        };
        const listing = {
            products: [
                {
                    gtin: 1234567890123,
                    dan: 99,
                    brandName: "TestBrand",
                    tileData: {
                        title: { tileHeadline: "Test Product 1L" },
                        self: "/p/d/99/test-product",
                        images: [{ tileSrc: "https://example/img.jpg" }],
                        price: { price: { current: { value: "12,90 Kč" } } },
                    },
                },
            ],
            currentPage: 0,
            totalPages: 1,
        };
        const { client } = buildClient([
            { match: "currentPage=", response: listing },
            { match: "/test-cat/", response: meta },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "test-cat", limit: 1 })) {
            out.push(p);
        }

        expect(out[0].ean).toBe("1234567890123");
        expect(out[0].brand).toBe("TestBrand");
        expect(out[0].currentPrice).toBe(12.9);
        expect(out[0].url).toContain("dm.cz");
    });

    it("retries with backoff when search-api returns 429", async () => {
        const meta = {
            mainData: [{ type: "products", query: { filters: "allCategories.id:010101" } }],
        };
        const listing = {
            products: [
                {
                    gtin: 999,
                    dan: 99,
                    brandName: "T",
                    tileData: { title: { tileHeadline: "X" }, self: "/p/x" },
                },
            ],
            currentPage: 0,
            totalPages: 1,
        };
        const sink = new MemoryHttpRequestSink();
        const client = new DmClient({ sink, rateLimitPerSecond: 1000, searchBackoffMs: [1, 1, 1] });
        const calls: string[] = [];
        let searchHits = 0;
        Object.defineProperty(client, "get", {
            value: async (path: string): Promise<unknown> => {
                calls.push(path);
                if (path.includes("/cz/search/")) {
                    searchHits++;
                    if (searchHits <= 2) {
                        throw new ApiClientError("Too many requests", {
                            method: "GET",
                            url: path,
                            status: 429,
                            statusText: "Too Many Requests",
                            responseData: { message: "Too many requests!" },
                        });
                    }

                    return listing;
                }

                if (path.includes("/test-cat/")) {
                    return meta;
                }

                throw new Error(`No fixture for ${path}`);
            },
        });

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "test-cat", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBe(1);
        expect(searchHits).toBe(3);
    });

    it("surfaces 429 to caller after exhausting backoff schedule", async () => {
        const meta = {
            mainData: [{ type: "products", query: { filters: "allCategories.id:010101" } }],
        };
        const sink = new MemoryHttpRequestSink();
        const client = new DmClient({ sink, rateLimitPerSecond: 1000, searchBackoffMs: [1, 1] });
        let searchHits = 0;
        Object.defineProperty(client, "get", {
            value: async (path: string): Promise<unknown> => {
                if (path.includes("/cz/search/")) {
                    searchHits++;
                    throw new ApiClientError("Too many requests", {
                        method: "GET",
                        url: path,
                        status: 429,
                        statusText: "Too Many Requests",
                    });
                }

                if (path.includes("/test-cat/")) {
                    return meta;
                }

                throw new Error(`No fixture for ${path}`);
            },
        });

        const consume = async (): Promise<void> => {
            for await (const _ of client.listCategory({ category: "test-cat", limit: 1 })) {
                // noop
            }
        };

        await expect(consume).toThrow(/Too many requests/);
        // Initial attempt + 2 backoff retries = 3 total.
        expect(searchHits).toBe(3);
    });

    it("respects opts.limit", async () => {
        const meta = {
            mainData: [{ type: "products", query: { filters: "allCategories.id:010101" } }],
        };
        const page0 = readFixture("product-listing-page0.json");
        const { client } = buildClient([
            { match: "currentPage=", response: page0 },
            { match: "/dekorativni-kosmetika/oci/rasenky", response: meta },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({
            category: "dekorativni-kosmetika/oci/rasenky",
            limit: 3,
        })) {
            out.push(p);
        }

        expect(out.length).toBe(3);
    });
});
