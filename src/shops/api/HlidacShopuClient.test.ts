import { describe, expect, it } from "bun:test";
import { HlidacShopuClient } from "@app/shops/api/HlidacShopuClient";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { env } from "@app/utils/env";

const HAS_NETWORK = !env.test.shouldSkipNetworkTests();
const ALZA_S3_URL = "https://data.hlidacshopu.cz/items/alza.cz/8023870/price-history.json";

describe("HlidacShopuClient", () => {
    it("constructs without error", () => {
        const sink = new MemoryHttpRequestSink();
        const c = new HlidacShopuClient({ sink });
        expect(c).toBeDefined();
    });

    it("priceHistoryS3 returns a parsed structure for a known slug", async () => {
        if (!HAS_NETWORK) {
            return;
        }

        const sink = new MemoryHttpRequestSink();
        const c = new HlidacShopuClient({ sink });
        const result = await c.priceHistoryS3("alza.cz", "8023870");
        expect(Array.isArray(result.entries)).toBe(true);
        expect(typeof result.commonPrice === "number" || result.commonPrice === null).toBe(true);
        expect(sink.events.some((e) => e.url.includes("price-history.json"))).toBe(true);
    });

    it("getByUrl prefers S3 and falls back to /v2/detail on 404", async () => {
        if (!HAS_NETWORK) {
            return;
        }

        const sink = new MemoryHttpRequestSink();
        const c = new HlidacShopuClient({ sink });
        const out = await c.getByUrl("https://www.alza.cz/d8023870.htm");
        expect(out.source === "s3" || out.source === "api").toBe(true);
        expect(out.parsed.origin).toBe("alza.cz");
    });

    it("emits http_requests events for non-lib endpoints (S3)", async () => {
        if (!HAS_NETWORK) {
            return;
        }

        const sink = new MemoryHttpRequestSink();
        const c = new HlidacShopuClient({ sink });
        try {
            await c.priceHistoryS3("alza.cz", "8023870");
        } catch {
            // tolerated
        }

        const s3Events = sink.events.filter((e) => e.source === "HlidacShopuClient:s3");
        expect(s3Events.length).toBeGreaterThan(0);
        expect(s3Events[0]?.url).toBe(ALZA_S3_URL);
    });

    it("emits a synthetic http_requests event for fetchDataSet (lib-wrapped)", async () => {
        if (!HAS_NETWORK) {
            return;
        }

        const sink = new MemoryHttpRequestSink();
        const c = new HlidacShopuClient({ sink });
        try {
            await c.detail("https://www.rohlik.cz/1419780-ritter-sport");
        } catch {
            // tolerated
        }

        const detailEvents = sink.events.filter((e) => e.source === "HlidacShopuClient:detail");
        expect(detailEvents.length).toBeGreaterThan(0);
        expect(detailEvents[0]?.responseExcerpt).toBeNull();
        expect(typeof detailEvents[0]?.durationMs).toBe("number");
    });
});
