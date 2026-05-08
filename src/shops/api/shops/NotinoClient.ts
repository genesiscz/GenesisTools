/**
 * NotinoClient -- Notino.cz product scraper.
 *
 * Notino lazy-loads price data after React mount. Uses a shared WebViewPool
 * for bulk scraping to reuse instances across product URLs.
 *
 * NOTE: This is an illustrative stub demonstrating WebViewPool adoption.
 * Plan 09 reclassed Notino as HTML-only after reading the actor source;
 * the real production NotinoClient (Plan 09 / Task 2) does NOT use WebView.
 *
 * Full implementation: see the shops PR that builds on this harness.
 */

import { WebView, WebViewPool } from "@app/utils/WebView";

export interface NotinoProduct {
    url: string;
    title: string;
    price: number;
    currency: "CZK";
    source: "notino";
}

export class NotinoClient {
    private pool: WebViewPool;

    constructor() {
        this.pool = new WebViewPool({
            size: 2,
            instanceOptions: {
                toolName: "shops",
                profileKey: "notino",
                timeoutMs: 25_000,
            },
        });
    }

    async fetchProduct(url: string, signal?: AbortSignal): Promise<NotinoProduct> {
        return this.pool.withInstance(async (wv: WebView) => {
            await wv.navigate(url, { signal });
            await wv.waitForSelector(".product-price, [class*='Price']", { signal });

            const title = await wv.evaluate<string>("document.title", { signal });

            return {
                url,
                title,
                price: 0,
                currency: "CZK",
                source: "notino",
            };
        }, signal);
    }

    async close(): Promise<void> {
        await this.pool.drain();
    }
}
