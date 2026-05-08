import { describe, expect, it } from "bun:test";
import { KosikClient } from "../api/shops/KosikClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { KosikRestCrawler } from "./KosikRestCrawler";

describe("KosikRestCrawler", () => {
    it("strategy is kosik-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new KosikClient();
            const crawler = new KosikRestCrawler(client, db);
            expect(crawler.strategy).toBe("kosik-rest");
        } finally {
            db.close();
        }
    });
});
