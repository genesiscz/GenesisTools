import { describe, expect, it } from "bun:test";
import { AlbertClient } from "@app/shops/api/shops/AlbertClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { AlbertCrawler } from "@app/shops/crawlers/AlbertCrawler";

describe("AlbertCrawler", () => {
    it("strategy is albert-graphql", () => {
        const db = buildTestDatabase();
        try {
            const client = new AlbertClient();
            const crawler = new AlbertCrawler(client, db);
            expect(crawler.strategy).toBe("albert-graphql");
        } finally {
            db.close();
        }
    });
});
