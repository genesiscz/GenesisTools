import { describe, expect, it } from "bun:test";
import { AlzaClient } from "../api/shops/AlzaClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { AlzaCrawler } from "./AlzaCrawler";

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
