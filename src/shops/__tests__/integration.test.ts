import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { MemoryHttpRequestSink } from "../lib/http-sink";
import { ingestFromHlidacResult } from "../lib/ingest";

describe("Plan 01 integration smoke", () => {
    it("ingest → DB → current_offers view round-trips end-to-end with no per-shop client", async () => {
        const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-int-")), "test.db"));
        const sink = new MemoryHttpRequestSink();

        const r1 = await ingestFromHlidacResult({
            db,
            url: "https://www.rohlik.cz/1419780-ritter-sport",
            data: {
                source: "s3",
                parsed: { origin: "rohlik.cz", itemId: "1419780", itemUrl: "1419780-ritter-sport" },
                history: {
                    commonPrice: 49.9,
                    minPrice: null,
                    entries: [{ d: "2026-05-01", c: 39.9, o: 49.9 }],
                },
                meta: {
                    itemId: "1419780",
                    itemName: "Ritter Sport mléčná čokoláda 100g",
                    itemImage: undefined,
                },
            },
        });
        const r2 = await ingestFromHlidacResult({
            db,
            url: "https://www.kosik.cz/p116247-nescafe-gold-instantni-kava",
            data: {
                source: "s3",
                parsed: {
                    origin: "kosik.cz",
                    itemId: null,
                    itemUrl: "p116247-nescafe-gold-instantni-kava",
                },
                history: {
                    commonPrice: 199,
                    minPrice: null,
                    entries: [{ d: "2026-05-01", c: 179, o: 199 }],
                },
                meta: {
                    itemId: "p116247-nescafe-gold-instantni-kava",
                    itemName: "Nescafé Gold instantní káva",
                    itemImage: undefined,
                },
            },
        });

        // 1) Two products, two distinct masters (no matcher yet).
        expect(r1.product.master_product_id).not.toBe(r2.product.master_product_id);

        // 2) Both shops auto-registered.
        expect(await db.getShopByOrigin("rohlik.cz")).toBeDefined();
        expect(await db.getShopByOrigin("kosik.cz")).toBeDefined();

        // 3) current_offers view shows the latest price per product.
        const all = await db.kysely().selectFrom("current_offers").selectAll().execute();
        expect(all).toHaveLength(2);

        // 4) Sink unaffected (no requests issued in this synthetic test).
        expect(sink.events).toHaveLength(0);

        // 5) http_requests table is reachable for an out-of-band insert.
        await db.insertHttpRequest({
            ts: "2026-05-08T10:00:00Z",
            method: "GET",
            url: "https://example.com",
            source: "test",
            duration_ms: 1,
        });
        const httpRows = await db.kysely().selectFrom("http_requests").selectAll().execute();
        expect(httpRows).toHaveLength(1);

        db.close();
    });
});
