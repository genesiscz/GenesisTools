import { describe, expect, it } from "bun:test";
import { KauflandClient } from "../api/shops/KauflandClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { KauflandCrawler } from "./KauflandCrawler";

describe("KauflandCrawler", () => {
    it("strategy is kaufland-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new KauflandClient();
            const crawler = new KauflandCrawler(client, db);
            expect(crawler.strategy).toBe("kaufland-html");
        } finally {
            db.close();
        }
    });
});
