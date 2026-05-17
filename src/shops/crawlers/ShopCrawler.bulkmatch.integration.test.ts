/**
 * Integration test: ShopCrawler.run() pipeline with BulkMatcher wiring.
 *
 * Pre-seeds a master_product with a known EAN, runs RohlikRestCrawler against
 * fixtures, and asserts:
 *   - Crawl loop persists products as 'pending'.
 *   - BulkMatcher.flush() then resolves them via the layer cascade.
 *   - At least one fixture product matches the seeded master by EAN.
 *   - No product remains 'pending' after run().
 *   - crawl_runs.status='completed', candidates_added incremented if relevant.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RohlikClient } from "@app/shops/api/shops/RohlikClient";
import { RohlikRestCrawler } from "@app/shops/crawlers/RohlikRestCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { SafeJSON } from "@app/utils/json";

interface FixtureProduct {
    id: number;
    name: string;
    brand?: string;
    slug?: string;
    images?: string[];
    ean?: string;
    [key: string]: unknown;
}

function readJson<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "../api/shops/__fixtures__/rohlik", rel), "utf8")) as T;
}

describe("ShopCrawler ← BulkMatcher wiring (integration)", () => {
    it("links a fixture product to a pre-seeded master via EAN; remaining products are auto-seeded or quarantined", async () => {
        const db = buildTestDatabase();
        try {
            const flat = readJson<{
                navigation: Record<string, { id: number; name: string; parentId: number; children: number[] }>;
            }>("flat-navigation.json");
            const count = readJson("category-count.json");
            const productsPage = readJson("category-products-page0.json");
            const productsBatch = readJson<FixtureProduct[]>("products-batch.json");
            const pricesBatch = readJson("products-prices-batch.json");

            const firstProduct = productsBatch[0];
            if (!firstProduct) {
                throw new Error("fixture products-batch.json has no products");
            }

            const seededEan = "9991234567890";
            // Graft `ean` into the first product — BulkMatcher's EAN-join pass
            // should then link it to the seeded master in one step.
            const patchedProductsBatch: FixtureProduct[] = productsBatch.map((p, idx) =>
                idx === 0 ? { ...p, ean: seededEan } : p
            );

            const client = new RohlikClient({ rateLimitPerSecond: 1000 });
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
                        return patchedProductsBatch;
                    }

                    if (path.includes("/api/v1/categories/normal/")) {
                        return productsPage;
                    }

                    throw new Error(`No fixture for ${path}`);
                },
            });

            const now = new Date().toISOString();
            db.raw().run(
                `INSERT INTO master_products
                   (canonical_name, canonical_name_normalized, canonical_slug, ean, total_offers, created_at, updated_at, verified_by)
                 VALUES (?, ?, ?, ?, 0, ?, ?, 'auto')`,
                [firstProduct.name, firstProduct.name.toLowerCase(), `seed-${firstProduct.id}`, seededEan, now, now]
            );
            const seededMaster = db.raw().query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get();
            if (!seededMaster) {
                throw new Error("seeded master insert failed");
            }

            const crawler = new RohlikRestCrawler(client, db);
            const firstCatId = Object.keys(flat.navigation)[0];
            const result = await crawler.run({ categoryId: firstCatId, limit: 5 });

            expect(result.status).toBe("completed");
            expect(result.productsSeen).toBeGreaterThan(0);

            const rows = db
                .raw()
                .query<{ id: number; ean: string | null; master_product_id: number | null; match_method: string }, []>(
                    "SELECT id, ean, master_product_id, match_method FROM products WHERE shop_origin='rohlik.cz'"
                )
                .all();

            expect(rows.length).toBeGreaterThan(0);

            // Invariant 1: no 'pending' rows remain.
            expect(rows.every((r) => r.match_method !== "pending")).toBe(true);

            // Invariant 2: the EAN-bearing product was linked to the seeded master via 'ean' method.
            const matched = rows.find((r) => r.ean === seededEan);
            expect(matched).toBeDefined();
            expect(matched?.master_product_id).toBe(seededMaster.id);
            expect(matched?.match_method).toBe("ean");

            // Invariant 3: every other product is either auto-seeded (non-null master) or
            // quarantined as gray-zone (null master + 'gray-zone' method).
            const others = rows.filter((r) => r.id !== matched?.id);
            for (const r of others) {
                if (r.master_product_id === null) {
                    expect(r.match_method).toBe("gray-zone");
                } else {
                    expect(r.match_method).not.toBe("pending");
                }
            }

            // Invariant 4: crawl_runs status flow finalized.
            const crawlRow = db
                .raw()
                .query<{ status: string }, []>(
                    "SELECT status FROM crawl_runs WHERE shop_origin='rohlik.cz' ORDER BY id DESC LIMIT 1"
                )
                .get();
            expect(crawlRow?.status).toBe("completed");
        } finally {
            db.close();
        }
    });
});
