import { describe, expect, it } from "bun:test";
import { MojaDmClient } from "../api/shops/MojaDmClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { MojaDmCrawler } from "./MojaDmCrawler";

describe("MojaDmCrawler", () => {
    it("strategy is mojadm-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new MojaDmClient();
            const crawler = new MojaDmCrawler(client, db);
            expect(crawler.strategy).toBe("mojadm-rest");
            expect(crawler.client.shopOrigin).toBe("mojadm.sk");
        } finally {
            db.close();
        }
    });
});
