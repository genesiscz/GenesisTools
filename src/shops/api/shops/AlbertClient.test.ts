import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { describe, expect, it } from "bun:test";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { AlbertClient } from "./AlbertClient";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/albert", rel), "utf8")) as T;
}

interface MockedClient {
    client: AlbertClient;
    calls: Array<{ url: string; params?: Record<string, unknown> }>;
}

function buildClient(routes: Array<{ match: string; response: unknown }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new AlbertClient({ sink, rateLimitPerSecond: 1000 });
    const calls: MockedClient["calls"] = [];
    Object.defineProperty(client, "get", {
        value: async (path: string, options?: { params?: Record<string, unknown> }) => {
            const opName = (options?.params as Record<string, string> | undefined)?.operationName ?? "";
            const variables = (options?.params as Record<string, string> | undefined)?.variables ?? "";
            const fullPath = `${path}?${opName}#${variables}`;
            calls.push({ url: fullPath, params: options?.params });
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

describe("AlbertClient.listCategories", () => {
    it("flattens categoryTreeList into Category[] with parent links", async () => {
        const nav = readFixture("left-hand-navigation.json");
        const { client } = buildClient([{ match: "LeftHandNavigationBar", response: nav }]);

        const cats = await client.listCategories();
        expect(cats.length).toBe(6);
        const root = cats.find((c) => c.id === "ROOT01");
        expect(root).toBeDefined();
        expect(root?.parentId).toBeUndefined();
        const child = cats.find((c) => c.id === "PEK01");
        expect(child?.parentId).toBe("ROOT01");
    });

    it("throws PersistedQueryNotFound with refresh-runbook hint when hash is stale", async () => {
        const errResp = {
            errors: [
                {
                    message: "PersistedQueryNotFound",
                    reasonCode: "PERSISTED_QUERY_NOT_FOUND",
                },
            ],
        };
        const { client } = buildClient([{ match: "LeftHandNavigationBar", response: errResp }]);

        let threw = false;
        try {
            await client.listCategories();
        } catch (e) {
            threw = true;
            expect(String(e)).toContain("PersistedQueryNotFound");
            expect(String(e)).toContain("refresh hashes");
        }

        expect(threw).toBe(true);
    });
});

describe("AlbertClient.listCategory", () => {
    it("yields products with discountedPrice parsing and breadcrumbs", async () => {
        const page0 = readFixture("category-products-page0.json");
        const { client } = buildClient([{ match: "GetCategoryProductSearch", response: page0 }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "PEK01", limit: 3 })) {
            out.push(p);
        }

        expect(out.length).toBe(3);
        expect(out[0].shopOrigin).toBe("albert.cz");
        expect(out[0].itemId).toBe("AL00001");
        expect(out[0].url).toContain("albert.cz");
        // Product 2 has a discounted price formatted "29,90 Kč" → currentPrice 29.9, originalPrice 39.9
        expect(out[1].currentPrice).toBe(29.9);
        expect(out[1].originalPrice).toBe(39.9);
        expect(out[0].categoryPath).toEqual(["Pekařství a cukrářství", "Pečivo"]);
    });

    it("paginates via pagination.totalPages", async () => {
        const page0 = readFixture("category-products-page0.json");
        const page1 = readFixture("category-products-page1.json");
        let callCount = 0;
        const sink = new MemoryHttpRequestSink();
        const client = new AlbertClient({ sink, rateLimitPerSecond: 1000 });
        Object.defineProperty(client, "get", {
            value: async () => {
                return callCount++ === 0 ? page0 : page1;
            },
        });

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "PEK01", limit: 100 })) {
            out.push(p);
        }

        expect(out.length).toBe(5);
    });

    it("rejects category errors", async () => {
        const errResp = {
            errors: [{ message: "Internal Error", reasonCode: "INTERNAL" }],
        };
        const { client } = buildClient([{ match: "GetCategoryProductSearch", response: errResp }]);

        let threw = false;
        try {
            for await (const _ of client.listCategory({ category: "PEK01", limit: 1 })) {
                // not reached
            }
        } catch (e) {
            threw = true;
            expect(String(e)).toContain("Internal Error");
        }

        expect(threw).toBe(true);
    });
});
