import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { describe, expect, it } from "bun:test";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { TetaClient } from "./TetaClient";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/teta", rel), "utf8")) as T;
}

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/teta", rel), "utf8");
}

interface MockedClient {
    client: TetaClient;
    calls: Array<{ method: "get" | "getText"; url: string }>;
}

function buildClient(
    routes: Array<{ method: "get" | "getText"; match: string; response: unknown }>
): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new TetaClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "get", {
        value: async (path: string, options?: { params?: Record<string, unknown> }) => {
            const params = options?.params
                ? `?${new URLSearchParams(options.params as Record<string, string>).toString()}`
                : "";
            const fullPath = `${path}${params}`;
            calls.push({ method: "get", url: fullPath });
            for (const r of routes) {
                if (r.method === "get" && fullPath.includes(r.match)) {
                    return r.response;
                }
            }

            throw new Error(`No JSON fixture for ${fullPath}`);
        },
    });
    Object.defineProperty(client, "getText", {
        value: async (path: string) => {
            calls.push({ method: "getText", url: path });
            for (const r of routes) {
                if (r.method === "getText" && path.includes(r.match)) {
                    return r.response as string;
                }
            }

            throw new Error(`No HTML fixture for ${path}`);
        },
    });
    return { client, calls };
}

describe("TetaClient.listCategories", () => {
    it("extracts taxon slugs from main menu HTML", async () => {
        const home = readHtml("root-menu.html");
        const { client } = buildClient([{ method: "getText", match: "/eshop/", response: home }]);

        const cats = await client.listCategories();
        expect(cats.length).toBe(4);
        expect(cats.some((c) => c.id === "krasa-a-zdravi")).toBe(true);
        expect(cats.some((c) => c.id === "vlasy")).toBe(true);
    });
});

describe("TetaClient.listCategory", () => {
    it("yields products with halves->CZK price decoding and HTML-tag stripping", async () => {
        const page0 = readFixture("category-listing-page0.json");
        const { client } = buildClient([{ method: "get", match: "/api/v2/shop/search/products-variants", response: page0 }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "krasa-a-zdravi", limit: 3 })) {
            out.push(p);
        }

        expect(out.length).toBe(3);
        expect(out[0].shopOrigin).toBe("tetadrogerie.cz");
        // Check halves->CZK conversion: 12990 / 100 = 129.9
        expect(out[0].currentPrice).toBe(129.9);
        expect(out[0].originalPrice).toBe(149.9);
        // Strip HTML tags from name
        expect(out[1].name).toBe("Sprchový gel 400 ml");
        expect(out[1].name).not.toContain("<strong>");
        // Item ID: leading zeros stripped
        expect(out[0].itemId).toBe("1234567");
    });

    it("filters multi-item discounts (zcmd treated as currentPrice)", async () => {
        const page0 = readFixture("category-listing-page0.json");
        const { client } = buildClient([{ method: "get", match: "/api/v2/", response: page0 }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "x", limit: 5 })) {
            out.push(p);
        }

        const multi = out.find((p) => p.itemId === "3333333");
        expect(multi).toBeDefined();
        // zcmd=199900 (full price), acmd=179900 (multi-pack price), conditions match
        // → use zcmd as current, no originalPrice
        expect(multi?.currentPrice).toBe(1999);
        expect(multi?.originalPrice).toBeUndefined();
    });

    it("paginates via pagination.lastPage", async () => {
        const page0 = readFixture("category-listing-page0.json");
        const page1 = readFixture("category-listing-page1.json");
        const { client, calls } = buildClient([
            { method: "get", match: "page=2", response: page1 },
            { method: "get", match: "page=1", response: page0 },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "krasa-a-zdravi", limit: 100 })) {
            out.push(p);
        }

        expect(calls.some((c) => c.url.includes("page=2"))).toBe(true);
        expect(out.length).toBe(5);
    });

    it("builds breadcrumb from taxa parent chain", async () => {
        const page0 = readFixture("category-listing-page0.json");
        const { client } = buildClient([{ method: "get", match: "/api/v2/", response: page0 }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "x", limit: 1 })) {
            out.push(p);
        }

        expect(out[0].categoryPath).toEqual(["Krása a zdraví", "Vlasy"]);
    });
});
