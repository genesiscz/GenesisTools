import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HlidacGetByUrlResult } from "@app/shops/api/HlidacShopuClient.types";
import type { RawProduct } from "@app/shops/api/ShopApiClient.types";
import { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { runGetProduct } from "@app/shops/lib/get-product";
import { ingestFromHlidacResult } from "@app/shops/lib/ingest";

describe("get-product flow", () => {
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

describe("runGetProduct ShopClient fallback", () => {
    function emptyHlidacResult(origin: string, url: string): HlidacGetByUrlResult {
        return {
            source: "api",
            parsed: { origin, itemId: null, itemUrl: url },
            history: null,
            detail: undefined,
            meta: undefined,
        };
    }

    function setup() {
        const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-getfb-")), "test.db"));
        return db;
    }

    it("falls through to ShopClient.getProduct when Hlídač returns no name", async () => {
        const db = setup();
        const url = "https://www.dm.cz/p/d/2586188/some-product";
        const stubClient = {
            async getByUrl() {
                return emptyHlidacResult("dm.cz", url);
            },
        };
        const stubResolver = async (_origin: string, _url: string): Promise<RawProduct | null> => ({
            shopOrigin: "dm.cz",
            slug: "2586188",
            itemId: "2586188",
            url,
            name: "Balea Sprchový gel Vanilka 250 ml",
            brand: "Balea",
            imageUrl: "https://media.dm-static.com/abc.jpg",
            currentPrice: 39.9,
            originalPrice: 49.9,
            observedAt: new Date("2026-05-09T10:00:00Z"),
            raw: {},
        });

        const result = await runGetProduct({
            url,
            db,
            client: stubClient as unknown as Parameters<typeof runGetProduct>[0]["client"],
            resolveFromShopClient: stubResolver,
        });

        expect(result.ingested.product.name).toBe("Balea Sprchový gel Vanilka 250 ml");
        expect(result.ingested.product.image_url).toBe("https://media.dm-static.com/abc.jpg");
        expect(result.source).toBe("scrape");
        expect(result.ingested.pricesRecorded).toBe(1);
        db.close();
    });

    it("uses deriveNameFromUrl as last resort when ShopClient returns null", async () => {
        const db = setup();
        const url = "https://www.dm.cz/p/d/2586188/balea-vanilka-sprchovy-gel";
        const stubClient = {
            async getByUrl() {
                return emptyHlidacResult("dm.cz", url);
            },
        };
        const stubResolver = async (): Promise<RawProduct | null> => null;

        const result = await runGetProduct({
            url,
            db,
            client: stubClient as unknown as Parameters<typeof runGetProduct>[0]["client"],
            resolveFromShopClient: stubResolver,
        });

        // deriveNameFromUrl strips numeric ID prefixes; "2586188-balea-vanilka..." should not be the name.
        expect(result.ingested.product.name).toContain("Balea");
        expect(result.ingested.product.name).not.toBe("2586188");
        db.close();
    });

    it("does NOT call ShopClient when Hlídač returned name + brand + EAN", async () => {
        const db = setup();
        const url = "https://www.rohlik.cz/1419780-ritter-sport";
        const data: HlidacGetByUrlResult = {
            source: "s3",
            parsed: { origin: "rohlik.cz", itemId: "1419780", itemUrl: "1419780-ritter-sport" },
            history: { commonPrice: null, minPrice: null, entries: [] },
            meta: { itemId: "1419780", itemName: "Ritter Sport 100g", itemImage: undefined },
            enrichment: { brand: "Ritter Sport", ean: "4000417025005" },
        };
        const stubClient = {
            async getByUrl() {
                return data;
            },
        };
        let calls = 0;
        const stubResolver = async (): Promise<RawProduct | null> => {
            calls++;
            return null;
        };

        const result = await runGetProduct({
            url,
            db,
            client: stubClient as unknown as Parameters<typeof runGetProduct>[0]["client"],
            resolveFromShopClient: stubResolver,
        });

        expect(calls).toBe(0);
        expect(result.ingested.product.name).toBe("Ritter Sport 100g");
        db.close();
    });

    it("CALLS ShopClient even when Hlídač returned a name, if brand/EAN missing", async () => {
        const db = setup();
        const url = "https://www.rohlik.cz/1419780-ritter-sport";
        const data: HlidacGetByUrlResult = {
            source: "s3",
            parsed: { origin: "rohlik.cz", itemId: "1419780", itemUrl: "1419780-ritter-sport" },
            history: { commonPrice: null, minPrice: null, entries: [] },
            meta: { itemId: "1419780", itemName: "Ritter Sport 100g", itemImage: undefined },
        };
        const stubClient = {
            async getByUrl() {
                return data;
            },
        };
        let calls = 0;
        const stubResolver = async (): Promise<RawProduct | null> => {
            calls++;
            return {
                shopOrigin: "rohlik.cz",
                slug: "1419780",
                url,
                name: "Ritter Sport 100g",
                brand: "Ritter Sport",
                ean: "4000417025005",
                observedAt: new Date(),
                raw: {},
            };
        };

        const result = await runGetProduct({
            url,
            db,
            client: stubClient as unknown as Parameters<typeof runGetProduct>[0]["client"],
            resolveFromShopClient: stubResolver,
        });

        expect(calls).toBe(1);
        expect(result.ingested.product.name).toBe("Ritter Sport 100g");
        expect(result.ingested.product.brand).toBe("Ritter Sport");
        expect(result.ingested.product.ean).toBe("4000417025005");
        db.close();
    });
});
