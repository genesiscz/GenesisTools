import { describe, expect, it } from "bun:test";
import { MountfieldClient } from "../api/shops/MountfieldClient";
import { buildTestDatabase } from "../test-utils/buildTestDatabase";
import { MountfieldCrawler } from "./MountfieldCrawler";

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
