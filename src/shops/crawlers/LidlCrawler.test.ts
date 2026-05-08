import { describe, expect, it } from "bun:test";
import { LidlClient } from "../api/shops/LidlClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { LidlCrawler } from "./LidlCrawler";

describe("LidlCrawler", () => {
    it("strategy is lidl-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new LidlClient();
            const crawler = new LidlCrawler(client, db);
            expect(crawler.strategy).toBe("lidl-rest");
        } finally {
            db.close();
        }
    });
});
