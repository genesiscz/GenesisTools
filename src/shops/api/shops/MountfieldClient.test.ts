import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { MountfieldClient } from "./MountfieldClient";

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/mountfield", rel), "utf8");
}

interface MockedClient {
    client: MountfieldClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; html: string }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new MountfieldClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "getText", {
        value: async (path: string) => {
            calls.push({ url: path });
            for (const r of routes) {
                if (path.includes(r.match)) {
                    return r.html;
                }
            }

            throw new Error(`No fixture for ${path}`);
        },
    });
    return { client, calls };
}

describe("MountfieldClient.listCategory", () => {
    it("yields RawProducts from a category page", async () => {
        const html = readHtml("category-page1.html");
        const { client } = buildClient([{ match: "/travni-sekacky", html }]);
        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "travni-sekacky", limit: 5 })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
        expect(out[0].shopOrigin).toBe("mountfield.cz");
        expect(out[0].itemId).toBe("7300003");
        expect(typeof out[0].currentPrice).toBe("number");
        expect(out[0].currentPrice).toBe(15990);
        expect(out[0].originalPrice).toBe(17990);
        expect(out[0].categoryPath).toEqual(["Domů", "Travní sekačky"]);
    });

    it("respects opts.limit", async () => {
        const html = readHtml("category-page1.html");
        const { client } = buildClient([{ match: "/travni-sekacky", html }]);
        const out: import("../ShopApiClient.types").RawProduct[] = [];
        for await (const p of client.listCategory({ category: "travni-sekacky", limit: 1 })) {
            out.push(p);
        }

        expect(out.length).toBe(1);
    });
});

describe("MountfieldClient.getProduct", () => {
    it("parses a product detail page", async () => {
        const html = readHtml("product-detail.html");
        const { client } = buildClient([{ match: "akumulatorova-travni-sekacka", html }]);
        const raw = await client.getProduct({
            url: "https://www.mountfield.cz/akumulatorova-travni-sekacka-stiga-collector-548-ae-nh-7300003",
        });

        expect(raw.shopOrigin).toBe("mountfield.cz");
        expect(raw.itemId).toBe("7300003");
        expect(raw.name.toLowerCase()).toContain("sekačka");
    });
});

describe("MountfieldClient.listCategories", () => {
    it("walks home navigation", async () => {
        const html = readHtml("home.html");
        const { client } = buildClient([{ match: "https://www.mountfield.cz/", html }]);
        const cats = await client.listCategories();
        expect(cats.length).toBe(2);
        expect(cats[0].name).toBe("Travní sekačky");
    });
});
