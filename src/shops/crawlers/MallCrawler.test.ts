import { describe, expect, it } from "bun:test";
import { MallClient } from "../api/shops/MallClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { MallCrawler } from "./MallCrawler";

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
