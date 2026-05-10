import { describe, expect, it } from "bun:test";
import { RohlikClient } from "@app/shops/api/shops/RohlikClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { RohlikRestCrawler } from "@app/shops/crawlers/RohlikRestCrawler";

describe("RohlikRestCrawler", () => {
    it("strategy is rohlik-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new RohlikClient();
            const crawler = new RohlikRestCrawler(client, db);
            expect(crawler.strategy).toBe("rohlik-rest");
        } finally {
            db.close();
        }
    });
});
