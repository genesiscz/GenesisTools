import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ItescoClient } from "@app/shops/api/shops/ItescoClient";
import { ItescoCrawler } from "@app/shops/crawlers/ItescoCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

function readFixture(rel: string): string {
    return readFileSync(join(import.meta.dir, "..", "api", "shops", "__fixtures__", "itesco", rel), "utf8");
}

describe("ItescoCrawler", () => {
    it("strategy is itesco-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new ItescoClient();
            const crawler = new ItescoCrawler(client, db);
            expect(crawler.strategy).toBe("itesco-html");
        } finally {
            db.close();
        }
    });

    it("crawls a category and resolves products via BulkMatcher (no row stays match_method='pending')", async () => {
        const db = buildTestDatabase();
        try {
            const home = readFixture("home.html");
            const page1 = readFixture("category-page1.html");

            const client = new ItescoClient({ rateLimitPerSecond: 1000, backoffMs: [1, 2, 3] });
            Object.defineProperty(client, "getText", {
                value: async (path: string): Promise<string> => {
                    if (path === "https://nakup.itesco.cz/groceries/cs-CZ/") {
                        return home;
                    }

                    return page1;
                },
            });

            const crawler = new ItescoCrawler(client, db);
            const result = await crawler.run({ limit: 3 });

            expect(result.productsSeen).toBeGreaterThan(0);
            expect(result.status).toBe("completed");

            const rows = db
                .raw()
                .query("SELECT shop_origin, master_product_id, match_method FROM products WHERE shop_origin = ?")
                .all("itesco.cz") as Array<{
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

    it("on Akamai escalation, base ShopCrawler records crawl_runs.status='failed' with Akamai error", async () => {
        const db = buildTestDatabase();
        try {
            const home = readFixture("home.html");
            const challenge = readFixture("akamai-sec-if-cpt.html");

            const client = new ItescoClient({ rateLimitPerSecond: 1000, backoffMs: [1, 2, 3] });
            let homeCalls = 0;
            Object.defineProperty(client, "getText", {
                value: async (path: string): Promise<string> => {
                    if (path === "https://nakup.itesco.cz/groceries/cs-CZ/" && homeCalls === 0) {
                        homeCalls++;
                        return home;
                    }

                    return challenge;
                },
            });

            const crawler = new ItescoCrawler(client, db);
            const result = await crawler.run({ limit: 5 });

            expect(result.status).toBe("failed");
            expect(result.error).toMatch(/Akamai/i);

            const crawlRow = db
                .raw()
                .query("SELECT status, error FROM crawl_runs WHERE shop_origin = ? ORDER BY id DESC LIMIT 1")
                .get("itesco.cz") as { status: string; error: string | null };
            expect(crawlRow).toBeDefined();
            expect(crawlRow.status).toBe("failed");
            expect(crawlRow.error).toMatch(/Akamai/i);
        } finally {
            db.close();
        }
    });
});
