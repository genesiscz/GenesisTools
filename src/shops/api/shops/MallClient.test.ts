import { describe, expect, it } from "bun:test";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { MallClient } from "@app/shops/api/shops/MallClient";

function buildClient(): MallClient {
    return new MallClient({ sink: new MemoryHttpRequestSink(), rateLimitPerSecond: 1000 });
}

describe("MallClient (deprecated)", () => {
    it("advertises capabilities live=false, listing=false, history=false", () => {
        const client = buildClient();
        expect(client.capabilities.live).toBe(false);
        expect(client.capabilities.listing).toBe(false);
        expect(client.capabilities.history).toBe(false);
        expect(client.shopOrigin).toBe("mall.cz");
    });

    it("listCategory throws the deprecation message", async () => {
        const client = buildClient();
        await expect(async () => {
            for await (const _ of client.listCategory({ category: "black-friday", limit: 1 })) {
                // noop
            }
        }).toThrow(/acquired by Allegro/);
    });

    it("getProduct throws the deprecation message", async () => {
        const client = buildClient();
        await expect(client.getProduct({ url: "https://www.mall.cz/anything/x" })).rejects.toThrow(
            /acquired by Allegro/
        );
    });

    it("listCategories returns an empty list", async () => {
        const client = buildClient();
        await expect(client.listCategories()).resolves.toEqual([]);
    });
});
