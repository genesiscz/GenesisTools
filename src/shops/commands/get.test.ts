import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { ingestFromHlidacResult } from "../lib/ingest";

describe("tools shops get (flow)", () => {
    it("end-to-end with a synthetic Hlidac payload writes everything to the DB", async () => {
        const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-cmd-")), "test.db"));
        const result = await ingestFromHlidacResult({
            db,
            url: "https://www.rohlik.cz/1419780-ritter-sport",
            data: {
                source: "s3",
                parsed: { origin: "rohlik.cz", itemId: "1419780", itemUrl: "1419780-ritter-sport" },
                history: {
                    commonPrice: 49.9,
                    minPrice: null,
                    entries: [
                        { d: "2026-05-01", c: 39.9, o: 49.9 },
                        { d: "2026-05-08", c: 44.9, o: 49.9 },
                    ],
                },
                meta: {
                    itemId: "1419780",
                    itemName: "Ritter Sport mléčná čokoláda 100g",
                    itemImage: undefined,
                },
            },
        });

        expect(result.product.shop_origin).toBe("rohlik.cz");
        expect(result.pricesRecorded).toBe(2);

        const offers = await db.getCurrentOffersForMaster(result.product.master_product_id ?? 0);
        expect(offers[0]?.current_price).toBe(44.9);
        db.close();
    });
});
