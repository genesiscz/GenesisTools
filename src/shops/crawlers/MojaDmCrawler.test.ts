import { describe, expect, it } from "bun:test";
import { MojaDmClient } from "@app/shops/api/shops/MojaDmClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { MojaDmCrawler } from "@app/shops/crawlers/MojaDmCrawler";

describe("MojaDmCrawler", () => {
    it("strategy is mojadm-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new MojaDmClient();
            const crawler = new MojaDmCrawler(client, db);
            expect(crawler.strategy).toBe("mojadm-rest");
            expect(crawler.client.shopOrigin).toBe("mojadm.sk");
        } finally {
            db.close();
        }
    });
});
