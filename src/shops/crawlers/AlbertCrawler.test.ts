import { describe, expect, it } from "bun:test";
import { AlbertClient } from "../api/shops/AlbertClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { AlbertCrawler } from "./AlbertCrawler";

describe("AlbertCrawler", () => {
    it("strategy is albert-graphql", () => {
        const db = buildTestDatabase();
        try {
            const client = new AlbertClient();
            const crawler = new AlbertCrawler(client, db);
            expect(crawler.strategy).toBe("albert-graphql");
        } finally {
            db.close();
        }
    });
});
