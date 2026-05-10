import { describe, expect, it } from "bun:test";
import { KnihyDobrovskyClient } from "@app/shops/api/shops/KnihyDobrovskyClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { KnihyDobrovskyCrawler } from "@app/shops/crawlers/KnihyDobrovskyCrawler";

describe("KnihyDobrovskyCrawler", () => {
    it("strategy is knihydobrovsky-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new KnihyDobrovskyClient();
            const crawler = new KnihyDobrovskyCrawler(client, db);
            expect(crawler.strategy).toBe("knihydobrovsky-html");
            expect(crawler.client.shopOrigin).toBe("knihydobrovsky.cz");
        } finally {
            db.close();
        }
    });
});
