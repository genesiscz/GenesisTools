import { describe, expect, it } from "bun:test";
import type { HttpRequestEvent, HttpRequestSink } from "../lib/http-sink";
import { ShopApiClient } from "./ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "./ShopApiClient.types";

class TestSink implements HttpRequestSink {
    public readonly events: HttpRequestEvent[] = [];
    async record(event: HttpRequestEvent): Promise<void> {
        this.events.push(event);
    }
}

class FakeRohlikClient extends ShopApiClient {
    readonly shopOrigin = "rohlik.cz";
    readonly displayName = "Rohlík.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: true,
        search: true,
        botProtection: "none",
    };
    async getProduct(): Promise<RawProduct> {
        throw new Error("not implemented in test");
    }
    async *listCategory(_: ListingOptions): AsyncIterable<RawProduct> {
        // empty
    }
    async listCategories(): Promise<Category[]> {
        return [];
    }
}

describe("ShopApiClient", () => {
    it("parses a known shop URL via @hlidac-shopu/lib", () => {
        const sink = new TestSink();
        const c = new FakeRohlikClient({ baseUrl: "https://www.rohlik.cz", sink });
        const parsed = c.parseUrl("https://www.rohlik.cz/1419780-ritter-sport");
        expect(parsed.shopOrigin).toBe("rohlik.cz");
        expect(parsed.itemId).toBe("1419780");
        expect(parsed.slug).toBe("1419780");
    });

    it("rejects a URL belonging to another shop", () => {
        const sink = new TestSink();
        const c = new FakeRohlikClient({ baseUrl: "https://www.rohlik.cz", sink });
        expect(() => c.parseUrl("https://www.kosik.cz/p116247-nescafe-gold")).toThrow(/does not belong to rohlik.cz/);
    });

    it("emits an http-request event through the sink on every request", async () => {
        const sink = new TestSink();
        const c = new FakeRohlikClient({ baseUrl: "https://data.hlidacshopu.cz", sink, retry: 0 });
        try {
            await c.requestRawPublic("GET", "/items/alza.cz/8023870/meta.json");
        } catch {
            // 404 is fine; we only care that the sink got an event.
        }
        expect(sink.events).toHaveLength(1);
        expect(sink.events[0]?.method).toBe("GET");
        expect(sink.events[0]?.shopOrigin).toBe("rohlik.cz");
        expect(sink.events[0]?.source).toBe("ShopApiClient:rohlik.cz");
        expect(typeof sink.events[0]?.durationMs).toBe("number");
    });
});
