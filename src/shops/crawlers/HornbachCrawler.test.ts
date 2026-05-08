import { describe, expect, it } from "bun:test";
import { HornbachClient } from "../api/shops/HornbachClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { HornbachCrawler } from "./HornbachCrawler";

describe("HornbachCrawler", () => {
    it("strategy is hornbach-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new HornbachClient();
            const crawler = new HornbachCrawler(client, db);
            expect(crawler.strategy).toBe("hornbach-html");
            expect(crawler.client.shopOrigin).toBe("hornbach.cz");
        } finally {
            db.close();
        }
    });
});
