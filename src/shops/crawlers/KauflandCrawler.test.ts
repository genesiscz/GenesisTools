import { describe, expect, it } from "bun:test";
import { KauflandClient } from "@app/shops/api/shops/KauflandClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { KauflandCrawler } from "@app/shops/crawlers/KauflandCrawler";

describe("KauflandCrawler", () => {
    it("strategy is kaufland-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new KauflandClient();
            const crawler = new KauflandCrawler(client, db);
            expect(crawler.strategy).toBe("kaufland-html");
        } finally {
            db.close();
        }
    });
});
