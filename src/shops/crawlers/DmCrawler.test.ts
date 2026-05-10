import { describe, expect, it } from "bun:test";
import { DmClient } from "@app/shops/api/shops/DmClient";
import { DmCrawler } from "@app/shops/crawlers/DmCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

describe("DmCrawler", () => {
    it("strategy is dm-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new DmClient();
            const crawler = new DmCrawler(client, db);
            expect(crawler.strategy).toBe("dm-rest");
        } finally {
            db.close();
        }
    });
});
