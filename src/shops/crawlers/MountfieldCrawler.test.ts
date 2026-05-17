import { describe, expect, it } from "bun:test";
import { MountfieldClient } from "@app/shops/api/shops/MountfieldClient";
import { MountfieldCrawler } from "@app/shops/crawlers/MountfieldCrawler";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";

describe("MountfieldCrawler", () => {
    it("strategy is mountfield-html", () => {
        const db = buildTestDatabase();
        try {
            const client = new MountfieldClient();
            const crawler = new MountfieldCrawler(client, db);
            expect(crawler.strategy).toBe("mountfield-html");
            expect(crawler.client.shopOrigin).toBe("mountfield.cz");
        } finally {
            db.close();
        }
    });
});
