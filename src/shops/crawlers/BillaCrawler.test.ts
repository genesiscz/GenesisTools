import { describe, expect, it } from "bun:test";
import { BillaClient } from "@app/shops/api/shops/BillaClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { BillaCrawler } from "@app/shops/crawlers/BillaCrawler";

describe("BillaCrawler", () => {
    it("strategy is billa-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new BillaClient();
            const crawler = new BillaCrawler(client, db);
            expect(crawler.strategy).toBe("billa-rest");
        } finally {
            db.close();
        }
    });
});
