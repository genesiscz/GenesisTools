import { describe, expect, it } from "bun:test";
import { AlzaClient } from "@app/shops/api/shops/AlzaClient";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { AlzaCrawler } from "@app/shops/crawlers/AlzaCrawler";

describe("AlzaCrawler", () => {
    it("strategy is alza-webview", () => {
        const db = buildTestDatabase();
        try {
            const client = new AlzaClient();
            const crawler = new AlzaCrawler(client, db);
            expect(crawler.strategy).toBe("alza-webview");
            expect(crawler.client.shopOrigin).toBe("alza.cz");
        } finally {
            db.close();
        }
    });
});
