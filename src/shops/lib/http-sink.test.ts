import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShopsDatabase } from "../db/ShopsDatabase";
import { DbHttpRequestSink, type HttpRequestEvent, MemoryHttpRequestSink } from "./http-sink";

async function tmpDb(): Promise<ShopsDatabase> {
    const db = new ShopsDatabase(join(mkdtempSync(join(tmpdir(), "shops-sink-")), "test.db"));
    await db.upsertShop({
        origin: "rohlik.cz",
        display_name: "Rohlík.cz",
        currency: "CZK",
        cap_live: 1,
        cap_history: 1,
        cap_listing: 1,
        cap_ean: 1,
        cap_search: 1,
        bot_protection: "none",
    });
    return db;
}

const baseEvent: HttpRequestEvent = {
    ts: "2026-05-08T10:00:00.000Z",
    method: "GET",
    url: "https://example.com/x",
    shopOrigin: "rohlik.cz",
    source: "ShopApiClient:rohlik.cz",
    operation: "getProduct",
    status: 200,
    durationMs: 42,
    requestId: "abc",
    requestExcerpt: null,
    responseExcerpt: '{"ok":true}',
    error: null,
    context: { slug: "1419780" },
};

describe("MemoryHttpRequestSink", () => {
    it("records events in order", async () => {
        const sink = new MemoryHttpRequestSink();
        await sink.record(baseEvent);
        await sink.record({ ...baseEvent, requestId: "def" });
        expect(sink.events).toHaveLength(2);
        expect(sink.events[0]?.requestId).toBe("abc");
        expect(sink.events[1]?.requestId).toBe("def");
    });
});

describe("DbHttpRequestSink", () => {
    it("inserts a row into http_requests", async () => {
        const db = await tmpDb();
        const sink = new DbHttpRequestSink(db);
        await sink.record(baseEvent);

        const rows = await db.kysely().selectFrom("http_requests").selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.url).toBe("https://example.com/x");
        expect(rows[0]?.shop_origin).toBe("rohlik.cz");
        expect(rows[0]?.status).toBe(200);
        expect(rows[0]?.response_excerpt).toBe('{"ok":true}');
        db.close();
    });

    it("truncates oversized excerpts", async () => {
        const db = await tmpDb();
        const sink = new DbHttpRequestSink(db);
        const big = "x".repeat(10_000);
        await sink.record({ ...baseEvent, responseExcerpt: big });
        const row = await db.kysely().selectFrom("http_requests").selectAll().executeTakeFirst();
        expect(row?.response_excerpt?.length).toBeLessThanOrEqual(2048);
        db.close();
    });

    it("survives a malformed context payload", async () => {
        const db = await tmpDb();
        const sink = new DbHttpRequestSink(db);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        await sink.record({ ...baseEvent, context: cyclic });
        const row = await db.kysely().selectFrom("http_requests").selectAll().executeTakeFirst();
        expect(row?.context_json).toBe("{}");
        db.close();
    });

    it("persists typed correlation columns when present", async () => {
        const db = await tmpDb();
        const sink = new DbHttpRequestSink(db);
        await sink.record({
            ...baseEvent,
            productSlug: "1419780",
            categoryId: "cat-99",
            // masterProductId left null (FK requires existing row to be set)
        });
        const row = await db.kysely().selectFrom("http_requests").selectAll().executeTakeFirst();
        expect(row?.product_slug).toBe("1419780");
        expect(row?.category_id).toBe("cat-99");
        expect(row?.master_product_id).toBeNull();
        db.close();
    });
});
