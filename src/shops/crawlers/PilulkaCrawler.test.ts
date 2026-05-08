import { describe, expect, it } from "bun:test";
import { PilulkaClient } from "../api/shops/PilulkaClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { PilulkaCrawler } from "./PilulkaCrawler";

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
