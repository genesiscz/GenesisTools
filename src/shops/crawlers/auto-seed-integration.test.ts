/**
 * Bulk crawl pipeline: products are written in 'pending' state during the crawl
 * loop, then BulkMatcher.flush() (wired into ShopCrawler.run() finalize step)
 * resolves master assignment. After a successful crawl, NO product should
 * remain match_method='pending' — every row is either linked to a master,
 * auto-seeded as its own master, or quarantined as 'gray-zone'.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RohlikClient } from "@app/shops/api/shops/RohlikClient";
import { RohlikRestCrawler } from "@app/shops/crawlers/RohlikRestCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { SafeJSON } from "@app/utils/json";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "../api/shops/__fixtures__/rohlik", rel), "utf8")) as T;
}

describe("bulk-crawl pipeline: BulkMatcher.flush wired into ShopCrawler.run", () => {
    it("after a successful crawl, no product remains match_method='pending'", async () => {
        const db = buildTestDatabase();
        try {
            const client = new RohlikClient({ rateLimitPerSecond: 1000 });
            const flat = readFixture<{
                navigation: Record<string, { id: number; name: string; parentId: number; children: number[] }>;
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
            expect(rows.every((r) => r.match_method !== "pending")).toBe(true);

            const crawlRow = db
                .raw()
                .query<{ status: string }, []>("SELECT status FROM crawl_runs ORDER BY id DESC LIMIT 1")
                .get();
            expect(crawlRow?.status).toBe("completed");
        } finally {
            db.close();
        }
    });
});
