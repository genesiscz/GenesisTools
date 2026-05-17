import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MojaDmClient } from "@app/shops/api/shops/MojaDmClient";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { SafeJSON } from "@app/utils/json";

function readFixture<T>(rel: string): T {
    const full = join(import.meta.dir, "__fixtures__/mojadm", rel);
    return SafeJSON.parse(readFileSync(full, "utf8")) as T;
}

interface MockedClient {
    client: MojaDmClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; response: unknown }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new MojaDmClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "get", {
        value: async (path: string, options?: { params?: Record<string, unknown> }): Promise<unknown> => {
            const params = options?.params
                ? `?${new URLSearchParams(options.params as Record<string, string>).toString()}`
                : "";
            const fullPath = `${path}${params}`;
            calls.push({ url: fullPath });
            for (const r of routes) {
                if (fullPath.includes(r.match)) {
                    return r.response;
                }
            }

            throw new Error(`No fixture for ${fullPath}`);
        },
    });
    return { client, calls };
}

describe("MojaDmClient", () => {
    it("uses .sk country slug, EUR currency, mojadm.sk origin", () => {
        const client = new MojaDmClient();
        expect(client.shopOrigin).toBe("mojadm.sk");
        expect(client.currency).toBe("EUR");
        expect(client.displayName).toBe("Moja DM");
    });

    it("declares cap_ean=true (inherited from DmClient)", () => {
        const client = new MojaDmClient();
        expect(client.capabilities.ean).toBe(true);
    });

    it("listCategory hits the SK content + search endpoints", async () => {
        const cat = readFixture("category-page.json");
        const listing = readFixture("product-listing.json");
        const { client, calls } = buildClient([
            { match: "/rootpage-dm-shop-sk-sk/", response: cat },
            { match: "/sk/search/static", response: listing },
        ]);

        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "telo", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBe(1);
        expect(out[0].shopOrigin).toBe("mojadm.sk");
        expect(out[0].url).toContain("mojadm.sk");
        expect(out[0].brand).toBe("balea");
        expect(out[0].currentPrice).toBe(3.99);
        expect(out[0].originalPrice).toBe(4.99);
        expect(calls[0].url).toContain("sk-sk/");
        expect(calls[1].url).toContain("/sk/search/");
    });
});
