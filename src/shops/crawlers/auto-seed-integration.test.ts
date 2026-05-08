/**
 * Per Spec.md schema deltas: bulk crawls write products in 'pending' state
 * and Plan 04's BulkMatcher resolves master assignment after the crawl.
 * The original Plan 03 'auto-seed' invariant ("every crawled product gets a
 * master immediately") was REPLACED — this test now guards the inverse.
 *
 * Single-product `tools shops get` uses `lib/ingest.ts` which still auto-seeds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { describe, expect, it } from "bun:test";
import { RohlikClient } from "../api/shops/RohlikClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { RohlikRestCrawler } from "./RohlikRestCrawler";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(
        readFileSync(join(import.meta.dir, "../api/shops/__fixtures__/rohlik", rel), "utf8")
    ) as T;
}

describe("bulk-crawl pending-state integration", () => {
    it("after crawl every product row is master_product_id=NULL with match_method='pending'", async () => {
        const db = buildTestDatabase();
        try {
            const client = new RohlikClient({ rateLimitPerSecond: 1000 });
            const flat = readFixture<{
                navigation: Record<
                    string,
                    { id: number; name: string; parentId: number; children: number[] }
                >;
            }>("flat-navigation.json");
            const count = readFixture("category-count.json");
            const productsPage = readFixture("category-products-page0.json");
            const productsBatch = readFixture("products-batch.json");
            const pricesBatch = readFixture("products-prices-batch.json");

            Object.defineProperty(client, "get", {
                value: async (path: string) => {
                    if (path.includes("/navigation/flat.json")) {
                        return flat;
                    }

                    if (path.includes("/products/count")) {
                        return count;
                    }

                    if (path.includes("/api/v1/products/prices")) {
                        return pricesBatch;
                    }

                    if (path.includes("/api/v1/products") && !path.includes("/categories/")) {
                        return productsBatch;
                    }

                    if (path.includes("/api/v1/categories/normal/")) {
                        return productsPage;
                    }

                    throw new Error(`No fixture for ${path}`);
                },
            });

            const crawler = new RohlikRestCrawler(client, db);
            const firstCatId = Object.keys(flat.navigation)[0];
            const result = await crawler.run({ categoryId: firstCatId, limit: 5 });
            expect(result.status).toBe("completed");
            expect(result.productsSeen).toBeGreaterThan(0);

            const rows = db
                .raw()
                .query<{ master_product_id: number | null; match_method: string }, []>(
                    "SELECT master_product_id, match_method FROM products"
                )
                .all();
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.every((r) => r.master_product_id === null)).toBe(true);
            expect(rows.every((r) => r.match_method === "pending")).toBe(true);
        } finally {
            db.close();
        }
    });
});
