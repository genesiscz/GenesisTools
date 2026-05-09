import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { MemoryHttpRequestSink } from "../../lib/http-sink";
import { LidlClient } from "./LidlClient";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/lidl", rel), "utf8")) as T;
}

function readHtml(rel: string): string {
    return readFileSync(join(import.meta.dir, "__fixtures__/lidl", rel), "utf8");
}

interface MockedClient {
    client: LidlClient;
    calls: Array<{ method: "get" | "getText"; url: string }>;
}

function buildClient(routes: Array<{ method: "get" | "getText"; match: string; response: unknown }>): MockedClient {
    const sink = new MemoryHttpRequestSink();
    const client = new LidlClient({ sink, rateLimitPerSecond: 1000 });
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

describe("LidlClient.listCategories", () => {
    it("extracts category nodes from home HTML with /c/ vs /h/ classification", async () => {
        const home = readHtml("home.html");
        const { client } = buildClient([{ method: "getText", match: "kategorie", response: home }]);

        const cats = await client.listCategories();
        expect(cats.length).toBeGreaterThan(0);
        // Some categories are leaves (`/c/...`), some are hubs (`/h/...`).
        const hubs = cats.filter((c) => c.parentId === "hub");
        const leaves = cats.filter((c) => c.parentId !== "hub");
        expect(hubs.length).toBeGreaterThan(0);
        expect(leaves.length).toBeGreaterThan(0);
    });
});

describe("LidlClient.listCategory", () => {
    it("yields products from API with breadcrumb decoding", async () => {
        const page0 = readFixture("api-category-page0.json");
        const { client } = buildClient([{ method: "get", match: "/q/api/category/", response: page0 }]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "akcni-letak/s10008644", limit: 50 })) {
            out.push(p);
        }

        expect(out.length).toBe(3);
        expect(out[0].shopOrigin).toBe("lidl.cz");
        expect(out[0].url).toContain("lidl.cz");
        expect(out[0].itemId).toBe("100012345");
        expect(out[0].currentPrice).toBe(24.9);
        expect(out[0].originalPrice).toBe(29.9);
        expect(out[0].categoryPath).toEqual(["potraviny", "napoje", "mleko"]);
    });

    it("paginates by offset until items.length === 0 or offset >= numFound", async () => {
        const page0 = readFixture<{ numFound?: number }>("api-category-page0.json");
        // Force pagination by claiming there are more results than the first page contains.
        page0.numFound = 5;
        const page1 = readFixture("api-category-page1.json");
        const { client, calls } = buildClient([
            { method: "get", match: "offset=3", response: page1 },
            { method: "get", match: "offset=0", response: page0 },
        ]);

        const out: Awaited<ReturnType<typeof client.getProduct>>[] = [];
        for await (const p of client.listCategory({ category: "akcni-letak/s10008644", limit: 100 })) {
            out.push(p);
        }

        expect(calls.some((c) => c.url.includes("offset=3"))).toBe(true);
        expect(out.length).toBe(5);
    });

    it("rejects hub-type categories with explicit error", async () => {
        const { client } = buildClient([]);

        let threw = false;
        try {
            for await (const _ of client.listCategory({ category: "damska-moda/h10003533", limit: 1 })) {
                // not reached
            }
        } catch (e) {
            threw = true;
            expect(String(e)).toContain("hub");
        }

        expect(threw).toBe(true);
    });
});
