import { describe, expect, it } from "bun:test";
import { TetaClient } from "../api/shops/TetaClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { TetaCrawler } from "./TetaCrawler";

describe("TetaCrawler", () => {
    it("strategy is teta-rest", () => {
        const db = buildTestDatabase();
        try {
            const client = new TetaClient();
            const crawler = new TetaCrawler(client, db);
            expect(crawler.strategy).toBe("teta-rest");
        } finally {
            db.close();
        }
    });
});
