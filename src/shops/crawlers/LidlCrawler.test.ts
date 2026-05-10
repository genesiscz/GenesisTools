import { describe, expect, it } from "bun:test";
import { LidlClient } from "@app/shops/api/shops/LidlClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { LidlCrawler } from "@app/shops/crawlers/LidlCrawler";

describe("LidlCrawler", () => {
    it("strategy is lidl-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new LidlClient();
            const crawler = new LidlCrawler(client, db);
            expect(crawler.strategy).toBe("lidl-rest");
        } finally {
            db.close();
        }
    });
});
