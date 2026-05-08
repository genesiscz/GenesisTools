import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { ingestFromHlidacResult } from "./ingest";

function tmpDb(): ShopsDatabase {
    return new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-ingest-")), "test.db"));
}

describe("ingestFromHlidacResult", () => {
    it("auto-seeds a master and persists product + prices", async () => {
        const db = tmpDb();
        const result = await ingestFromHlidacResult({
            db,
            url: "https://www.alza.cz/d8023870.htm",
            data: {
                source: "s3",
                parsed: { origin: "alza.cz", itemId: "8023870", itemUrl: "8023870" },
                history: {
                    commonPrice: 209,
                    minPrice: null,
                    entries: [
                        { d: "2026-01-01", c: 99, o: 209 },
                        { d: "2026-02-01", c: 109, o: 209 },
                    ],
                },
                meta: { itemId: "8023870", itemName: "Kryt na mobil", itemImage: "https://cdn.alza.cz/x.jpg" },
            },
        });

        expect(result.product.shop_origin).toBe("alza.cz");
        expect(result.product.slug).toBe("8023870");
        expect(result.product.master_product_id).toBeGreaterThan(0);
        expect(result.product.match_method).toBe("auto-seed");
        expect(result.pricesRecorded).toBe(2);

        const offers = await db.getCurrentOffersForMaster(result.product.master_product_id ?? 0);
        expect(offers).toHaveLength(1);
        expect(offers[0]?.current_price).toBe(109);
        db.close();
    });

    it("re-ingesting the same URL keeps the same product id and master_product_id", async () => {
        const db = tmpDb();
        const a = await ingestFromHlidacResult({
            db,
            url: "https://www.alza.cz/d8023870.htm",
            data: {
                source: "s3",
                parsed: { origin: "alza.cz", itemId: "8023870", itemUrl: "8023870" },
                history: {
                    commonPrice: 209,
                    minPrice: null,
                    entries: [{ d: "2026-01-01", c: 99, o: 209 }],
                },
                meta: { itemId: "8023870", itemName: "Kryt", itemImage: undefined },
            },
        });
        const b = await ingestFromHlidacResult({
            db,
            url: "https://www.alza.cz/d8023870.htm",
            data: {
                source: "s3",
                parsed: { origin: "alza.cz", itemId: "8023870", itemUrl: "8023870" },
                history: {
                    commonPrice: 209,
                    minPrice: null,
                    entries: [
                        { d: "2026-01-01", c: 99, o: 209 },
                        { d: "2026-02-01", c: 109, o: 209 },
                    ],
                },
                meta: { itemId: "8023870", itemName: "Kryt v2", itemImage: undefined },
            },
        });
        expect(b.product.id).toBe(a.product.id);
        expect(b.product.master_product_id).toBe(a.product.master_product_id);
        expect(b.product.name).toBe("Kryt v2");
        db.close();
    });

    it("from a fresh empty DB, first ingest succeeds (master invariant)", async () => {
        const db = tmpDb();
        const masters = await db.kysely().selectFrom("master_products").selectAll().execute();
        expect(masters).toHaveLength(0);

        const out = await ingestFromHlidacResult({
            db,
            url: "https://www.rohlik.cz/1419780-ritter-sport",
            data: {
                source: "s3",
                parsed: { origin: "rohlik.cz", itemId: "1419780", itemUrl: "ritter-sport" },
                history: {
                    commonPrice: 49.9,
                    minPrice: null,
                    entries: [{ d: "2026-05-01", c: 39.9, o: 49.9 }],
                },
                meta: { itemId: "1419780", itemName: "Ritter Sport mléčná" },
            },
        });
        expect(out.product.master_product_id).toBeGreaterThan(0);
        const masters2 = await db.kysely().selectFrom("master_products").selectAll().execute();
        expect(masters2).toHaveLength(1);
        db.close();
    });

    it("auto-creates the shop row on first ingest", async () => {
        const db = tmpDb();
        await ingestFromHlidacResult({
            db,
            url: "https://www.kosik.cz/p116247-nescafe-gold-instantni-kava",
            data: {
                source: "s3",
                parsed: { origin: "kosik.cz", itemId: null, itemUrl: "p116247-nescafe-gold-instantni-kava" },
                history: {
                    commonPrice: 199,
                    minPrice: null,
                    entries: [{ d: "2026-05-01", c: 179, o: 199 }],
                },
                meta: {
                    itemId: "p116247-nescafe-gold-instantni-kava",
                    itemName: "Nescafé Gold instantní káva",
                },
            },
        });
        const shop = await db.getShopByOrigin("kosik.cz");
        expect(shop?.origin).toBe("kosik.cz");
        db.close();
    });
});
