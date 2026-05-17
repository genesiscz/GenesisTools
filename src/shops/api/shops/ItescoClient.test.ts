import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ItescoClient } from "@app/shops/api/shops/ItescoClient";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";

function readFixture(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/itesco", rel), "utf8");
}

interface MockedClient {
    client: ItescoClient;
    calls: Array<{ url: string }>;
}

function buildClient(routes: Array<{ match: string; response: string | (() => Promise<never>) }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new ItescoClient({ sink, rateLimitPerSecond: 1000, backoffMs: [1, 2, 3] });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "getText", {
        value: async (path: string): Promise<string> => {
            calls.push({ url: path });
            for (const r of routes) {
                if (path.includes(r.match)) {
                    if (typeof r.response === "string") {
                        return r.response;
                    }

                    return await r.response();
                }
            }

            throw new Error(`No fixture for ${path}`);
        },
    });
    return { client, calls };
}

describe("ItescoClient.listCategories", () => {
    it("walks the homepage and extracts top-level superdepartment URLs", async () => {
        const home = readFixture("home.html");
        const { client, calls } = buildClient([{ match: "groceries/cs-CZ/", response: home }]);

        const cats = await client.listCategories();

        expect(cats.length).toBeGreaterThan(2);
        for (const c of cats) {
            expect(c.url).toMatch(/^https:\/\/nakup\.itesco\.cz\/groceries\/cs-CZ\/shop\/[^/]+\/all$/);
        }

        const ids = new Set(cats.map((c) => c.id));
        expect(ids.size).toBe(cats.length);
        expect(calls.length).toBe(1);
    });

    it("filters out non-locale and subcategory URLs", async () => {
        const home = readFixture("home.html");
        const { client } = buildClient([{ match: "groceries/cs-CZ/", response: home }]);

        const cats = await client.listCategories();
        // SK locale link should NOT appear.
        expect(cats.every((c) => !(c.url ?? "").includes("sk-SK"))).toBe(true);
        // Sub-category /shop/pekarna/some-subcat/all has 2 path segments after /shop/, regex requires 1.
        expect(cats.every((c) => !(c.url ?? "").includes("some-subcat"))).toBe(true);
    });
});

describe("ItescoClient.listCategory", () => {
    it("yields RawProducts from category-page1.html (Apollo-cache extraction)", async () => {
        const page1 = readFixture("category-page1.html");
        const { client } = buildClient([{ match: "shop/pekarna/all", response: page1 }]);

        const out = [];
        for await (const p of client.listCategory({
            category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
            limit: 50,
        })) {
            out.push(p);
            if (out.length >= 50) {
                break;
            }
        }

        expect(out.length).toBe(3);
        for (const p of out) {
            expect(p.shopOrigin).toBe("itesco.cz");
            expect(p.url).toMatch(/^https:\/\/nakup\.itesco\.cz\/groceries\/cs-CZ\/products\/\d+$/);
            expect(typeof p.itemId).toBe("string");
            expect(p.name.length).toBeGreaterThan(0);
        }

        const breadcrumb = out.find((p) => Array.isArray(p.categoryPath) && p.categoryPath.length > 0);
        expect(breadcrumb).toBeDefined();
        expect(breadcrumb?.categoryPath).toContain("Pekárna");
    });

    it("parses promotion description into originalPrice", async () => {
        const page1 = readFixture("category-page1.html");
        const { client } = buildClient([{ match: "shop/pekarna/all", response: page1 }]);

        const out = [];
        for await (const p of client.listCategory({
            category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
            limit: 50,
        })) {
            out.push(p);
        }

        const rohlik = out.find((p) => p.itemId === "100200");
        expect(rohlik).toBeDefined();
        expect(rohlik?.currentPrice).toBe(3.5);
        expect(rohlik?.originalPrice).toBe(4.4);
    });

    it("divides prices by 10 for QuantityOrWeight items (0.1kg unit)", async () => {
        const page1 = readFixture("category-page1.html");
        const { client } = buildClient([{ match: "shop/pekarna/all", response: page1 }]);

        const out = [];
        for await (const p of client.listCategory({
            category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
            limit: 50,
        })) {
            out.push(p);
        }

        const bageta = out.find((p) => p.itemId === "100300");
        expect(bageta).toBeDefined();
        expect(bageta?.unit).toBe("0.1kg");
        expect(bageta?.currentPrice).toBe(25);
        expect(bageta?.inStock).toBe(false);
    });

    it("paginates by appending ?page=N up to ceil(total/pageSize)", async () => {
        const page1 = readFixture("category-page1.html");
        const page2 = readFixture("category-page2.html");
        const { client, calls } = buildClient([
            { match: "?page=2", response: page2 },
            { match: "shop/pekarna/all", response: page1 },
        ]);

        const out = [];
        for await (const p of client.listCategory({
            category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
            limit: 1000,
        })) {
            out.push(p);
        }

        const visitedPage2 = calls.some((c) => c.url.includes("page=2"));
        expect(visitedPage2).toBe(true);
        expect(out.length).toBe(5);
    });

    it("respects opts.limit", async () => {
        const page1 = readFixture("category-page1.html");
        const { client } = buildClient([{ match: "shop/pekarna/all", response: page1 }]);

        const out = [];
        for await (const p of client.listCategory({
            category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
            limit: 2,
        })) {
            out.push(p);
        }

        expect(out.length).toBe(2);
    });
});

describe("ItescoClient capabilities", () => {
    it("declares cap_ean=false, botProtection='akamai'", () => {
        const sink = new MemoryHttpRequestSink();
        const client = new ItescoClient({ sink });
        expect(client.capabilities.ean).toBe(false);
        expect(client.capabilities.live).toBe(true);
        expect(client.capabilities.history).toBe(true);
        expect(client.capabilities.listing).toBe(true);
        expect(client.capabilities.search).toBe(false);
        expect(client.capabilities.botProtection).toBe("akamai");
    });
});

describe("ItescoClient Akamai detection + backoff", () => {
    it("treats sec-if-cpt-container body as a block, escalates 3 attempts, then throws AKAMAI_ESCALATION", async () => {
        const challenge = readFixture("akamai-sec-if-cpt.html");
        const { client, calls } = buildClient([{ match: "shop/pekarna", response: challenge }]);

        await expect(
            (async () => {
                const out = [];
                for await (const p of client.listCategory({
                    category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
                })) {
                    out.push(p);
                }
            })()
        ).rejects.toThrow(/Akamai escalation/i);

        // 4 attempts (initial + 3 backoffs).
        expect(calls.length).toBe(4);
    });

    it("treats Reference # body as a block", async () => {
        const challenge = readFixture("akamai-reference-id.html");
        const { client } = buildClient([{ match: "shop/pekarna", response: challenge }]);

        await expect(
            (async () => {
                for await (const _ of client.listCategory({
                    category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
                })) {
                    // drain
                }
            })()
        ).rejects.toThrow(/Akamai escalation/i);
    });

    it("treats status 403 thrown by getText as a block", async () => {
        const sink = new MemoryHttpRequestSink();
        const client = new ItescoClient({ sink, rateLimitPerSecond: 1000, backoffMs: [1, 2, 3] });
        let attempts = 0;
        Object.defineProperty(client, "getText", {
            value: async (): Promise<string> => {
                attempts++;
                const err = new Error("HTTP 403") as Error & { status: number };
                err.status = 403;
                throw err;
            },
        });

        await expect(
            (async () => {
                for await (const _ of client.listCategory({
                    category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
                })) {
                    // drain
                }
            })()
        ).rejects.toThrow(/Akamai escalation/i);

        expect(attempts).toBe(4);
    });

    it("does NOT escalate non-Akamai errors", async () => {
        const sink = new MemoryHttpRequestSink();
        const client = new ItescoClient({ sink, rateLimitPerSecond: 1000, backoffMs: [1, 2, 3] });
        let attempts = 0;
        Object.defineProperty(client, "getText", {
            value: async (): Promise<string> => {
                attempts++;
                const err = new Error("HTTP 500") as Error & { status: number };
                err.status = 500;
                throw err;
            },
        });

        await expect(
            (async () => {
                for await (const _ of client.listCategory({
                    category: "https://nakup.itesco.cz/groceries/cs-CZ/shop/pekarna/all",
                })) {
                    // drain
                }
            })()
        ).rejects.toThrow(/HTTP 500/);

        expect(attempts).toBe(1);
    });
});
