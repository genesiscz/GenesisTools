import { describe, expect, it } from "bun:test";
import { NotinoClient } from "../api/shops/NotinoClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { NotinoCrawler } from "./NotinoCrawler";

describe("NotinoCrawler", () => {
    it("strategy is notino-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new NotinoClient();
            const crawler = new NotinoCrawler(client, db);
            expect(crawler.strategy).toBe("notino-html");
            expect(crawler.client.shopOrigin).toBe("notino.cz");
        } finally {
            db.close();
        }
    });
});
