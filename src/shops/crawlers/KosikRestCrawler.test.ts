import { describe, expect, it } from "bun:test";
import { KosikClient } from "@app/shops/api/shops/KosikClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { KosikRestCrawler } from "@app/shops/crawlers/KosikRestCrawler";

describe("KosikRestCrawler", () => {
    it("strategy is kosik-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new KosikClient();
            const crawler = new KosikRestCrawler(client, db);
            expect(crawler.strategy).toBe("kosik-rest");
        } finally {
            db.close();
        }
    });
});
