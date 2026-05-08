import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { MallClient } from "./MallClient";
import type { MallCampaignResponse } from "./MallClient.types";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/mall", rel), "utf8")) as T;
}

interface MockedClient {
    client: MallClient;
    calls: Array<{ body: { variables: { pagination: { offset: number } } } }>;
}

function buildClient(responses: MallCampaignResponse[]): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const calls: MockedClient["calls"] = [];
    const client = new MallClient({ sink, rateLimitPerSecond: 1000 });
    let i = 0;
    Object.defineProperty(client, "post", {
        value: async (_path: string, body: unknown): Promise<MallCampaignResponse> => {
            calls.push({ body: body as { variables: { pagination: { offset: number } } } });
            const r = responses[i] ?? responses[responses.length - 1];
            i++;
            return r;
        },
    });
    return { client, calls };
}

describe("MallClient.listCategory", () => {
    it("paginates across pages and yields RawProducts", async () => {
        const page1 = readFixture<MallCampaignResponse>("graphql-campaign-page1.json");
        const page2 = readFixture<MallCampaignResponse>("graphql-campaign-page2.json");
        const { client, calls } = buildClient([page1, page2]);

        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "black-friday", limit: 200 })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
        expect(out[0].shopOrigin).toBe("mall.cz");
        expect(out[0].itemId).toBe("v-12345");
        expect(out[0].currentPrice).toBe(1299);
        expect(out[0].originalPrice).toBe(1499);
        expect(calls[0].body.variables.pagination.offset).toBe(0);
    });

    it("respects opts.limit", async () => {
        const page1 = readFixture<MallCampaignResponse>("graphql-campaign-page1.json");
        const { client } = buildClient([page1]);

        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "black-friday", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBe(1);
    });

    it("requires opts.category", async () => {
        const { client } = buildClient([]);
        await expect(async () => {
            for await (const _ of client.listCategory({ limit: 1 })) {
                // noop
            }
        }).toThrow(/requires opts.category/);
    });
});

describe("MallClient.getProduct", () => {
    it("maps a single Product entry into RawProduct", async () => {
        const detail = readFixture<MallCampaignResponse>("graphql-product-detail.json");
        const { client } = buildClient([detail]);

        const raw = await client.getProduct({ url: "https://www.mall.cz/stavebnice/lego/lego-classic-11030" });

        expect(raw.shopOrigin).toBe("mall.cz");
        expect(raw.itemId).toBe("v-12345");
        expect(raw.name).toContain("Lego");
        expect(raw.currentPrice).toBe(1299);
        expect(raw.originalPrice).toBe(1499);
        expect(raw.inStock).toBe(true);
    });

    it("requires opts.url", async () => {
        const { client } = buildClient([]);
        await expect(client.getProduct({ slug: "x" })).rejects.toThrow(/requires opts.url/);
    });
});
