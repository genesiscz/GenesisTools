import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { BillaClient } from "./BillaClient";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/billa", rel), "utf8")) as T;
}

interface MockedClient {
    client: BillaClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; response: unknown }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new BillaClient({ sink, rateLimitPerSecond: 1000 });
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

describe("BillaClient.listCategories", () => {
    it("returns hardcoded category list", async () => {
        const client = new BillaClient({ rateLimitPerSecond: 1000 });
        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        expect(cats.some((c) => c.id === "pekarna")).toBe(true);
    });
});

describe("BillaClient.listCategory", () => {
    it("yields products with toCZK conversion (halves of cents → CZK)", async () => {
        const page0 = readFixture("category-page0.json");
        const { client } = buildClient([
            { match: "/api/product-discovery/categories/pekarna/products", response: page0 },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "pekarna", limit: 10 })) {
            out.push(p);
        }

        expect(out.length).toBe(3);
        expect(out[0].name).toBe("Veka 500g");
        expect(out[0].currentPrice).toBe(24.9);
        expect(out[0].itemId).toBe("001234567");
        expect(out[0].shopOrigin).toBe("billa.cz");
        expect(out[0].url).toContain("billa.cz");
        expect(out[0].categoryPath).toEqual(["Pekárna", "Pečivo"]);
    });

    it("paginates when count === pageSize", async () => {
        const page0 = readFixture<{ count?: number; total?: number }>("category-page0.json");
        const page1 = readFixture("category-page1.json");
        // Force the count === PAGE_SIZE (100) condition to trigger pagination
        page0.count = 100;
        page0.total = 200;
        const { client, calls } = buildClient([
            { match: "page=1", response: page1 },
            { match: "page=0", response: page0 },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "pekarna", limit: 100 })) {
            out.push(p);
        }

        expect(calls.some((c) => c.url.includes("page=1"))).toBe(true);
        expect(out.length).toBeGreaterThan(3);
    });

    it("respects opts.limit", async () => {
        const page0 = readFixture("category-page0.json");
        const { client } = buildClient([{ match: "/api/product-discovery/categories/", response: page0 }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "pekarna", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBe(1);
    });
});
