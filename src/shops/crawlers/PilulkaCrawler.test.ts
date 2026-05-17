import { describe, expect, it } from "bun:test";
import { PilulkaClient } from "@app/shops/api/shops/PilulkaClient";
import { PilulkaCrawler } from "@app/shops/crawlers/PilulkaCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

describe("PilulkaCrawler", () => {
    it("strategy is pilulka-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new PilulkaClient();
            const crawler = new PilulkaCrawler(client, db);
            expect(crawler.strategy).toBe("pilulka-html");
            expect(crawler.client.shopOrigin).toBe("pilulka.cz");
        } finally {
            db.close();
        }
    });
});
