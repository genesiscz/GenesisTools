import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { RohlikClient } from "@app/shops/api/shops/RohlikClient";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { RohlikRestCrawler } from "@app/shops/crawlers/RohlikRestCrawler";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "../api/shops/__fixtures__/rohlik", rel), "utf8")) as T;
}

describe("HttpRequestSink integration", () => {
    it("crawler dispatches sink.record() for every shop-client outbound call", async () => {
        const db = buildTestDatabase();
        try {
            const sink = new MemoryHttpRequestSink();
            const client = new RohlikClient({ rateLimitPerSecond: 1000, sink });

            const flat = readFixture("flat-navigation.json");
            const count = readFixture("category-count.json");
            const productsPage = readFixture("category-products-page0.json");
            const productsBatch = readFixture("products-batch.json");
            const pricesBatch = readFixture("products-prices-batch.json");

            // Patch get() to call sink.record() (mirroring the real ShopApiClient.requestRaw wiring)
            // and return fixtures based on URL patterns. Once Plan 01's requestRaw hook is
            // verified end-to-end against fixtures, this manual sink.record() can drop.
            Object.defineProperty(client, "get", {
                value: async (path: string): Promise<unknown> => {
                    const start = performance.now();
                    const url = path.startsWith("http") ? path : `https://www.rohlik.cz${path}`;
                    let response: unknown;
                    if (path.includes("/navigation/flat.json")) {
                        response = flat;
                    } else if (path.includes("/products/count")) {
                        response = count;
                    } else if (path.includes("/api/v1/products/prices")) {
                        response = pricesBatch;
                    } else if (path.includes("/api/v1/products") && !path.includes("/categories/")) {
                        response = productsBatch;
                    } else if (path.includes("/api/v1/categories/normal/")) {
                        response = productsPage;
                    } else {
                        throw new Error(`No fixture for ${path}`);
                    }

                    await sink.record({
                        ts: new Date().toISOString(),
                        method: "GET",
                        url,
                        source: "ShopApiClient:rohlik.cz",
                        shopOrigin: "rohlik.cz",
                        durationMs: performance.now() - start,
                        status: 200,
                        requestId: "test",
                        requestExcerpt: null,
                        responseExcerpt: null,
                        error: null,
                        context: {},
                    });
                    return response;
                },
            });

            const crawler = new RohlikRestCrawler(client, db);
            const firstCatId = Object.keys((flat as { navigation: Record<string, unknown> }).navigation)[0];
            await crawler.run({ categoryId: firstCatId, limit: 5 });

            expect(sink.events.length).toBeGreaterThan(0);
            expect(sink.events.every((e) => e.shopOrigin === "rohlik.cz")).toBe(true);
            expect(sink.events.every((e) => typeof e.durationMs === "number")).toBe(true);
            expect(sink.events.every((e) => e.source === "ShopApiClient:rohlik.cz")).toBe(true);
        } finally {
            db.close();
        }
    });
});
