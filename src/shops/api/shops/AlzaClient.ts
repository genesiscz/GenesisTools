/**
 * AlzaClient -- Alza.cz product scraper.
 *
 * Alza is a JavaScript SPA; product price and availability are injected by
 * React after mount. We use WebView to render the page before extracting data.
 *
 * Full implementation: see the shops PR that builds on this harness.
 */

import { WebView } from "@app/utils/WebView";
import type { WebViewOptions } from "@app/utils/WebView";

const ALZA_WEBVIEW_OPTIONS: WebViewOptions = {
    toolName: "shops",
    profileKey: "alza",
    consolePipe: false,
    width: 1280,
    height: 900,
    timeoutMs: 20_000,
};

export interface AlzaProduct {
    url: string;
    title: string;
    price: number;
    currency: "CZK";
    available: boolean;
    source: "alza";
}

export class AlzaClient {
    /**
     * Fetch product data for a single Alza product URL.
     * Creates a fresh WebView per call; for bulk use, build a pool variant.
     */
    async fetchProduct(url: string, signal?: AbortSignal): Promise<AlzaProduct> {
        await using wv = new WebView(ALZA_WEBVIEW_OPTIONS);
        await wv.navigate(url, { signal });
        await wv.waitForSelector("[class*='price']", { signal });

        const title = await wv.evaluate<string>("document.title", { signal });

        return {
            url,
            title,
            price: 0,
            currency: "CZK",
            available: false,
            source: "alza",
        };
    }
}
