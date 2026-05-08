import { describe, expect, it } from "bun:test";
import { RohlikClient } from "../api/shops/RohlikClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { RohlikRestCrawler } from "./RohlikRestCrawler";

describe("RohlikRestCrawler", () => {
    it("strategy is rohlik-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new RohlikClient();
            const crawler = new RohlikRestCrawler(client, db);
            expect(crawler.strategy).toBe("rohlik-rest");
        } finally {
            db.close();
        }
    });
});
