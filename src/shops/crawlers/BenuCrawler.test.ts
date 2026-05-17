import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BenuClient } from "@app/shops/api/shops/BenuClient";
import { BenuCrawler } from "@app/shops/crawlers/BenuCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

function readFixture(rel: string): string {
    return readFileSync(join(import.meta.dir, "..", "api", "shops", "__fixtures__", "benu", rel), "utf8");
}

describe("BenuCrawler", () => {
    it("strategy is benu-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new BenuClient();
            const crawler = new BenuCrawler(client, db);
            expect(crawler.strategy).toBe("benu-html");
        } finally {
            db.close();
        }
    });

    it("crawls categories and resolves products via BulkMatcher (no row stays match_method='pending')", async () => {
        const db = buildTestDatabase();
        try {
            const home = readFixture("home.html");
            const listing = readFixture("category-listing.html");

            const client = new BenuClient({ rateLimitPerSecond: 1000 });
            Object.defineProperty(client, "getText", {
                value: async (path: string): Promise<string> => {
                    if (path === "https://www.benu.cz") {
                        return home;
                    }

                    return listing;
                },
            });

            const crawler = new BenuCrawler(client, db);
            const result = await crawler.run({ limit: 3 });

            expect(result.productsSeen).toBeGreaterThan(0);
            expect(result.productsSeen).toBeLessThanOrEqual(3);
            expect(result.status).toBe("completed");

            const rows = db
                .raw()
                .query("SELECT shop_origin, master_product_id, match_method FROM products WHERE shop_origin = ?")
                .all("benu.cz") as Array<{
                shop_origin: string;
                master_product_id: number | null;
                match_method: string;
            }>;
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.every((r) => r.match_method !== "pending")).toBe(true);
        } finally {
            db.close();
        }
    });

    it("records prices via recordPrice with source='crawl:benu-html'", async () => {
        const db = buildTestDatabase();
        try {
            const home = readFixture("home.html");
            const listing = readFixture("category-listing.html");

            const client = new BenuClient({ rateLimitPerSecond: 1000 });
            Object.defineProperty(client, "getText", {
                value: async (path: string): Promise<string> => {
                    if (path === "https://www.benu.cz") {
                        return home;
                    }

                    return listing;
                },
            });

            const crawler = new BenuCrawler(client, db);
            await crawler.run({ limit: 3 });

            const priceCount = db
                .raw()
                .query("SELECT COUNT(*) as count FROM prices WHERE source = ?")
                .get("crawl:benu-html") as { count: number };
            expect(priceCount.count).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });
});
