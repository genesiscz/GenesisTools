import { describe, expect, it } from "bun:test";
import { MallClient } from "@app/shops/api/shops/MallClient";
import { MallCrawler } from "@app/shops/crawlers/MallCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

describe("MallCrawler", () => {
    it("strategy is mall-graphql", () => {
        const db = buildTestDatabase();
        try {
            const client = new MallClient();
            const crawler = new MallCrawler(client, db);
            expect(crawler.strategy).toBe("mall-graphql");
            expect(crawler.client.shopOrigin).toBe("mall.cz");
        } finally {
            db.close();
        }
    });
});
