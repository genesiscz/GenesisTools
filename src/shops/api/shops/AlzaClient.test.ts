import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { type WebView, WebViewPool } from "@app/utils/WebView";
import { MemoryHttpRequestSink } from "@app/shops/lib/http-sink";
import { AlzaClient } from "@app/shops/api/shops/AlzaClient";
import type { AlzaCategoryListing, AlzaPageData } from "@app/shops/api/shops/AlzaClient.types";

function readFixture<T>(rel: string): T {
    return SafeJSON.parse(readFileSync(join(import.meta.dir, "__fixtures__/alza", rel), "utf8")) as T;
}

interface MockWebView {
    navigate(url: string, opts?: unknown): Promise<void>;
    evaluate<T>(expr: string, opts?: unknown): Promise<T>;
    waitForSelector(sel: string, opts?: unknown): Promise<void>;
    close(): void;
    closed: boolean;
}

interface MockBuildOptions {
    evaluate: Map<string, unknown>;
}

function buildMockWebView(opts: MockBuildOptions): MockWebView {
    let closed = false;
    return {
        async navigate(): Promise<void> {
            // noop
        },
        async evaluate<T>(expr: string): Promise<T> {
            for (const [matcher, val] of opts.evaluate) {
                if (expr.includes(matcher)) {
                    return val as T;
                }
            }

            throw new Error(`No mock evaluate for ${expr}`);
        },
        async waitForSelector(): Promise<void> {
            // noop
        },
        close(): void {
            closed = true;
        },
        get closed(): boolean {
            return closed;
        },
    };
}

describe("AlzaClient.getProduct", () => {
    it("maps evaluated page data to RawProduct", async () => {
        const pageData = readFixture<AlzaPageData>("evaluate-product-data.json");
        const mockWv = buildMockWebView({
            evaluate: new Map([["__ALZA_PRODUCT_DATA__", pageData]]),
        });
        const client = new AlzaClient({
            sink: new MemoryHttpRequestSink(),
            rateLimitPerSecond: 1000,
            webview: mockWv as unknown as WebView,
        });

        const raw = await client.getProduct({
            url: "https://www.alza.cz/EN/lenovo-thinkpad-t14-gen5-d10221687.htm",
        });

        expect(raw.shopOrigin).toBe("alza.cz");
        expect(raw.itemId).toBe("d10221687");
        expect(raw.name).toContain("Lenovo");
        expect(raw.currentPrice).toBe(39990);
        expect(raw.originalPrice).toBe(44990);
        expect(raw.ean).toBe("0197529826676");
        expect(raw.observedAt).toBeInstanceOf(Date);
    });

    it("handles missing original price", async () => {
        const minimal: AlzaPageData = {
            id: "d999",
            name: "x",
            url: "https://www.alza.cz/x-d999.htm",
            price: { current: 100, currency: "CZK" },
            availability: "InStock",
        };
        const mockWv = buildMockWebView({
            evaluate: new Map([["__ALZA_PRODUCT_DATA__", minimal]]),
        });
        const client = new AlzaClient({
            sink: new MemoryHttpRequestSink(),
            rateLimitPerSecond: 1000,
            webview: mockWv as unknown as WebView,
        });

        const raw = await client.getProduct({ url: "https://www.alza.cz/x-d999.htm" });
        expect(raw.originalPrice).toBeUndefined();
        expect(raw.currentPrice).toBe(100);
    });

    it("requires url (slug-only is not supported)", async () => {
        const mockWv = buildMockWebView({ evaluate: new Map() });
        const client = new AlzaClient({
            sink: new MemoryHttpRequestSink(),
            rateLimitPerSecond: 1000,
            webview: mockWv as unknown as WebView,
        });

        await expect(client.getProduct({ slug: "d999" })).rejects.toThrow(/requires opts.url/);
    });
});

describe("AlzaClient.listCategory", () => {
    it("yields RawProducts streamed from a single page", async () => {
        const listing = readFixture<AlzaCategoryListing>("evaluate-category-listing.json");

        let createdInstances = 0;
        const factory = (): WebView => {
            createdInstances++;
            return buildMockWebView({
                evaluate: new Map([["__ALZA_CATEGORY__", listing]]),
            }) as unknown as WebView;
        };

        const pool = new WebViewPool({ size: 2, factory });
        const client = new AlzaClient({
            sink: new MemoryHttpRequestSink(),
            rateLimitPerSecond: 1000,
            webviewPool: pool,
        });

        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const item of client.listCategory({ category: "18842782", limit: 10 })) {
            out.push(item);
        }

        expect(out).toHaveLength(2);
        expect(out[0].slug).toBe("d10221687");
        expect(out[0].currentPrice).toBe(39990);
        expect(out[1].slug).toBe("d10221688");
        expect(createdInstances).toBeGreaterThanOrEqual(1);

        await client.close();
    });

    it("respects limit before pagination", async () => {
        const listing = readFixture<AlzaCategoryListing>("evaluate-category-listing.json");
        const factory = (): WebView =>
            buildMockWebView({ evaluate: new Map([["__ALZA_CATEGORY__", listing]]) }) as unknown as WebView;

        const pool = new WebViewPool({ size: 2, factory });
        const client = new AlzaClient({
            sink: new MemoryHttpRequestSink(),
            rateLimitPerSecond: 1000,
            webviewPool: pool,
        });

        const out: import("@app/shops/api/ShopApiClient.types").RawProduct[] = [];
        for await (const item of client.listCategory({ category: "18842782", limit: 1 })) {
            out.push(item);
        }

        expect(out).toHaveLength(1);
        await client.close();
    });
});

describe("AlzaClient.close()", () => {
    it("closes the borrowed singleton WebView", async () => {
        const mockWv = buildMockWebView({ evaluate: new Map() });
        const client = new AlzaClient({
            sink: new MemoryHttpRequestSink(),
            rateLimitPerSecond: 1000,
            webview: mockWv as unknown as WebView,
        });

        await client.close();
        expect(mockWv.closed).toBe(true);
    });

    it("listCategories() returns empty (curated seeds live elsewhere)", async () => {
        const mockWv = buildMockWebView({ evaluate: new Map() });
        const client = new AlzaClient({
            sink: new MemoryHttpRequestSink(),
            rateLimitPerSecond: 1000,
            webview: mockWv as unknown as WebView,
        });

        const cats = await client.listCategories();
        expect(cats).toEqual([]);
    });
});
