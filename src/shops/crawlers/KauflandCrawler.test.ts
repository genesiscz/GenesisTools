import { describe, expect, it } from "bun:test";
import { KauflandClient } from "@app/shops/api/shops/KauflandClient";
import { KauflandCrawler } from "@app/shops/crawlers/KauflandCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

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
