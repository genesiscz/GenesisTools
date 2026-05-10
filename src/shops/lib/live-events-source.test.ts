import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { buildTestDatabase } from "@app/shops/test-utils/buildTestDatabase";
import { getInitialLiveEvents, resetLiveEventsSourceForTest } from "@app/shops/lib/live-events-source";

let db: ShopsDatabase;

beforeEach(() => {
    db = buildTestDatabase();
    resetLiveEventsSourceForTest();
});

afterEach(() => {
    db.close();
});

async function insertHttp(
    overrides: Partial<{
        url: string;
        status: number | null;
        error: string | null;
        request_excerpt: string | null;
        response_excerpt: string | null;
    }> = {}
): Promise<void> {
    await db.insertHttpRequest({
        ts: new Date().toISOString(),
        method: "GET",
        url: overrides.url ?? "https://example.com/x",
        shop_origin: null,
        source: "test",
        operation: null,
        status: overrides.status ?? 200,
        duration_ms: 42,
        request_bytes: null,
        response_bytes: null,
        request_id: "req-1",
        crawl_run_id: null,
        product_slug: null,
        master_product_id: null,
        category_id: null,
        error: overrides.error ?? null,
        request_excerpt: overrides.request_excerpt ?? null,
        response_excerpt: overrides.response_excerpt ?? null,
        context_json: "{}",
    });
}

describe("getInitialLiveEvents", () => {
    it("includes error, request_excerpt, response_excerpt on http-request rows", async () => {
        await insertHttp({
            url: "https://example.com/fail",
            status: null,
            error: "ECONNRESET: socket hang up",
            request_excerpt: "GET /fail\nUser-Agent: tools-shops",
            response_excerpt: "<html>500</html>",
        });

        const events = await getInitialLiveEvents(db);

        expect(events.length).toBe(1);
        const data = events[0]?.data as Record<string, unknown>;
        expect(data.error).toBe("ECONNRESET: socket hang up");
        expect(data.request_excerpt).toBe("GET /fail\nUser-Agent: tools-shops");
        expect(data.response_excerpt).toBe("<html>500</html>");
    });

    it("returns null excerpts/error when none stored", async () => {
        await insertHttp({ url: "https://example.com/ok", status: 200 });

        const events = await getInitialLiveEvents(db);
        const data = events[0]?.data as Record<string, unknown>;
        expect(data.error).toBeNull();
        expect(data.request_excerpt).toBeNull();
        expect(data.response_excerpt).toBeNull();
    });
});
