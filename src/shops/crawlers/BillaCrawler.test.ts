import { describe, expect, it } from "bun:test";
import { BillaClient } from "../api/shops/BillaClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { BillaCrawler } from "./BillaCrawler";

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
