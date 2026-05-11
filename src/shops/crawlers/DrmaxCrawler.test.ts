import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DrmaxClient } from "@app/shops/api/shops/DrmaxClient";
import { DrmaxCrawler } from "@app/shops/crawlers/DrmaxCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

function readFixture(rel: string): string {
    return readFileSync(join(import.meta.dir, "..", "api", "shops", "__fixtures__", "drmax", rel), "utf8");
}

describe("DrmaxCrawler", () => {
    it("strategy is drmax-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new DrmaxClient();
            const crawler = new DrmaxCrawler(client, db);
            expect(crawler.strategy).toBe("drmax-html");
        } finally {
            db.close();
        }
    });

    it("crawls categories and resolves products via BulkMatcher (no row stays match_method='pending')", async () => {
        const db = buildTestDatabase();
        try {
            const xml = readFixture("sitemap-kategorie.xml");
            const page1 = readFixture("category-page1.html");
            const page2 = readFixture("category-page2.html");

            const client = new DrmaxClient({ rateLimitPerSecond: 1000 });
            Object.defineProperty(client, "getText", {
                value: async (path: string): Promise<string> => {
                    if (path.includes("sitemap")) {
                        return xml;
                    }

                    if (path.includes("page=2")) {
                        return page2;
                    }

                    return page1;
                },
            });

            const crawler = new DrmaxCrawler(client, db);
            const result = await crawler.run({ limit: 5 });

            expect(result.productsSeen).toBeGreaterThan(0);
            expect(result.productsSeen).toBeLessThanOrEqual(5);
            expect(result.status).toBe("completed");

            const rows = db
                .raw()
                .query("SELECT shop_origin, master_product_id, match_method FROM products WHERE shop_origin = ?")
                .all("drmax.cz") as Array<{
                shop_origin: string;
                master_product_id: number | null;
                match_method: string;
            }>;
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.every((r) => r.match_method !== "pending")).toBe(true);

            const crawlRow = db
                .raw()
                .query("SELECT status FROM crawl_runs WHERE shop_origin = ? ORDER BY id DESC LIMIT 1")
                .get("drmax.cz") as { status: string } | undefined;
            expect(crawlRow?.status).toBe("completed");
        } finally {
            db.close();
        }
    });

    it("records prices for emitted products", async () => {
        const db = buildTestDatabase();
        try {
            const xml = readFixture("sitemap-kategorie.xml");
            const page1 = readFixture("category-page1.html");

            const client = new DrmaxClient({ rateLimitPerSecond: 1000 });
            Object.defineProperty(client, "getText", {
                value: async (path: string): Promise<string> => {
                    if (path.includes("sitemap")) {
                        return xml;
                    }

                    return page1;
                },
            });

            const crawler = new DrmaxCrawler(client, db);
            await crawler.run({ limit: 3 });

            const priceCount = db
                .raw()
                .query("SELECT COUNT(*) as count FROM prices WHERE source = ?")
                .get("crawl:drmax-html") as { count: number };
            expect(priceCount.count).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });
});
