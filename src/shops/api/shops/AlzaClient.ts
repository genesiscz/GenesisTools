// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/alza/main.js
//
// We do NOT port the actor's mobile-API + handshake + proxy-rotation pipeline.
// We drive the public desktop SPA via WebView because that pipeline requires
// per-IP cookie state and proxy rotation we don't want to maintain. The SPA
// exposes the same product JSON via window.__ALZA_PRODUCT_DATA__ /
// window.__ALZA_CATEGORY__ globals.

import { type WebView, type WebViewOptions, WebViewPool } from "@app/utils/WebView";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type { AlzaCategoryListing, AlzaListingEntry, AlzaPageData } from "@app/shops/api/shops/AlzaClient.types";

const ALZA_ORIGIN = "alza.cz";
const ROOT = "https://www.alza.cz";

const NAVIGATION_TIMEOUT_MS = 25_000;
const EVALUATE_TIMEOUT_MS = 10_000;
const POOL_SIZE = 4;

const ALZA_WEBVIEW_OPTIONS: WebViewOptions = {
    toolName: "shops",
    profileKey: "alza",
    dataStore: "ephemeral",
    consolePipe: false,
    width: 1280,
    height: 900,
    timeoutMs: NAVIGATION_TIMEOUT_MS,
};

export interface AlzaClientConfig extends ShopApiClientConstructorConfig {
    webview?: WebView;
    webviewPool?: WebViewPool;
}

export class AlzaClient extends ShopApiClient {
    readonly shopOrigin = ALZA_ORIGIN;
    readonly displayName = "Alza.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: false,
        listing: true,
        ean: true,
        search: false,
        botProtection: "akamai",
    };

    private singleton?: WebView;
    private pool?: WebViewPool;

    constructor(config: AlzaClientConfig = {}) {
        const { webview, webviewPool, ...rest } = config;
        super({
            baseUrl: ROOT,
            loggerContext: { provider: "alza" },
            rateLimitPerSecond: rest.rateLimitPerSecond ?? 0.5,
            ...rest,
        });

        this.singleton = webview;
        this.pool = webviewPool;
    }

    private getSingleton(): WebView {
        if (!this.singleton) {
            throw new Error(
                "AlzaClient: webview not injected and lazy construction skipped (production WebView wiring lands with the bulk-crawl runtime)"
            );
        }

        return this.singleton;
    }

    private getPool(): WebViewPool {
        if (!this.pool) {
            this.pool = new WebViewPool({ size: POOL_SIZE, instanceOptions: ALZA_WEBVIEW_OPTIONS });
        }

        return this.pool;
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("AlzaClient.getProduct requires opts.url (slug-only lookup is not supported)");
        }

        await this.waitTurn();
        const wv = this.getSingleton();
        await wv.navigate(input.url, { timeoutMs: NAVIGATION_TIMEOUT_MS, signal: input.signal });
        await wv.waitForSelector("[data-testid='price-box']", {
            timeoutMs: EVALUATE_TIMEOUT_MS,
            signal: input.signal,
        });
        const data = await wv.evaluate<AlzaPageData>("window.__ALZA_PRODUCT_DATA__", {
            timeoutMs: EVALUATE_TIMEOUT_MS,
            signal: input.signal,
        });
        return this.toRawProduct(data);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("AlzaClient.listCategory requires opts.category (Alza categoryId)");
        }

        const pool = this.getPool();
        let page = 1;
        let yielded = 0;

        while (true) {
            opts.signal?.throwIfAborted();
            const url = `${ROOT}/category/${opts.category}.htm?page=${page}`;

            const listing = await pool.withInstance(async (wv) => {
                await wv.navigate(url, { timeoutMs: NAVIGATION_TIMEOUT_MS, signal: opts.signal });
                await wv.waitForSelector("[data-testid='product-list']", {
                    timeoutMs: EVALUATE_TIMEOUT_MS,
                    signal: opts.signal,
                });
                return wv.evaluate<AlzaCategoryListing>("window.__ALZA_CATEGORY__", {
                    timeoutMs: EVALUATE_TIMEOUT_MS,
                    signal: opts.signal,
                });
            }, opts.signal);

            for (const entry of listing.items) {
                yield this.entryToRawProduct(entry, listing.categoryName);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            if (!listing.hasMore) {
                return;
            }

            page++;
        }
    }

    async listCategories(): Promise<Category[]> {
        return [];
    }

    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.drain();
            this.pool = undefined;
        }

        if (this.singleton && !this.singleton.closed) {
            this.singleton.close();
            this.singleton = undefined;
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private toRawProduct(data: AlzaPageData): RawProduct {
        return {
            shopOrigin: ALZA_ORIGIN,
            slug: data.id,
            itemId: data.id,
            url: data.url,
            name: data.name,
            brand: data.brand,
            ean: data.ean,
            imageUrl: data.imageUrl,
            currentPrice: data.price.current,
            originalPrice: data.price.original,
            inStock: data.availability === "InStock",
            categoryPath: data.categoryPath,
            observedAt: new Date(),
            raw: { source: "alza-webview", data },
        };
    }

    private entryToRawProduct(entry: AlzaListingEntry, categoryName: string): RawProduct {
        return {
            shopOrigin: ALZA_ORIGIN,
            slug: entry.id,
            itemId: entry.id,
            url: entry.url,
            name: entry.name,
            imageUrl: entry.imageUrl,
            currentPrice: entry.currentPrice,
            originalPrice: entry.originalPrice,
            inStock: entry.availability === "InStock",
            categoryPath: categoryName ? [categoryName] : undefined,
            observedAt: new Date(),
            raw: { source: "alza-webview-list", entry },
        };
    }
}
