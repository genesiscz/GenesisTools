import { describe, expect, it } from "bun:test";
import { DmClient } from "../api/shops/DmClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { DmCrawler } from "./DmCrawler";

describe("DmCrawler", () => {
    it("strategy is dm-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new DmClient();
            const crawler = new DmCrawler(client, db);
            expect(crawler.strategy).toBe("dm-rest");
        } finally {
            db.close();
        }
    });
});
