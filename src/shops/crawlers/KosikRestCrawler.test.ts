import { describe, expect, it } from "bun:test";
import { KosikClient } from "@app/shops/api/shops/KosikClient";
import { KosikRestCrawler } from "@app/shops/crawlers/KosikRestCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

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
