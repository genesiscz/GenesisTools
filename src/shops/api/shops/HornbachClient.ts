// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/hornbach-daily/main.js

import { parseHTML } from "linkedom";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import { HORNBACH_SELECTORS } from "./HornbachClient.types";

const HORNBACH_ORIGIN = "hornbach.cz";
const ROOT = "https://www.hornbach.cz";

function parsePrice(text: string | null | undefined): number | undefined {
    if (!text) {
        return undefined;
    }

    const cleaned = text.replace(/\s/g, "").replace("Kč", "").replace("€", "").replace(",", ".");
    const n = Number.parseFloat(cleaned);
    return Number.isNaN(n) ? undefined : n;
}

export class HornbachClient extends ShopApiClient {
    readonly shopOrigin = HORNBACH_ORIGIN;
    readonly displayName = "Hornbach.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: false,
        search: false,
        botProtection: "none",
    };

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            baseUrl: ROOT,
            loggerContext: { provider: "hornbach" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("HornbachClient.getProduct requires opts.url");
        }

        await this.waitTurn();
        const html = await this.getText(input.url, { signal: input.signal });
        return parseDetail(html, input.url);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("HornbachClient.listCategory requires opts.category");
        }

        let page = 1;
        let yielded = 0;

        while (true) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const url = `${ROOT}/c/${opts.category}/?page=${page}`;
            const html = await this.getText(url, { signal: opts.signal });
            const products = parseListing(html);

            if (products.length === 0) {
                return;
            }

            for (const p of products) {
                yield p;
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            page++;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(`${ROOT}/`);
        const { document } = parseHTML(html);
        const out: Category[] = [];
        for (const a of Array.from(document.querySelectorAll(HORNBACH_SELECTORS.TOP_CATEGORIES))) {
            const href = a.getAttribute("href");
            const name = a.getAttribute("title") ?? a.textContent?.trim();
            if (href !== null && name) {
                const url = new URL(href, ROOT).href;
                const slug = new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "");
                out.push({ id: slug, name, url });
            }
        }

        return out;
    }
}

function parseListing(html: string): RawProduct[] {
    const { document } = parseHTML(html);
    const out: RawProduct[] = [];

    for (const card of Array.from(document.querySelectorAll(HORNBACH_SELECTORS.PRODUCT_CARD))) {
        const link = card.querySelector("a");
        const href = link?.getAttribute("href");
        if (!href) {
            continue;
        }

        const itemUrl = new URL(href, ROOT).href;
        const idMatch = href.match(/SH(\d+)/);
        const itemId = idMatch ? `SH${idMatch[1]}` : undefined;
        if (!itemId) {
            continue;
        }

        const name = card.querySelector(HORNBACH_SELECTORS.PRODUCT_TITLE)?.textContent?.trim() ?? "";
        const currentPrice = parsePrice(card.querySelector(HORNBACH_SELECTORS.PRODUCT_PRICE)?.textContent);
        const originalPrice = parsePrice(card.querySelector(HORNBACH_SELECTORS.PRODUCT_OLD_PRICE)?.textContent);
        const img = card.querySelector("img");
        const imageUrl = img?.getAttribute("data-src") ?? img?.getAttribute("src") ?? undefined;

        out.push({
            shopOrigin: HORNBACH_ORIGIN,
            slug: itemId,
            itemId,
            url: itemUrl,
            name,
            currentPrice,
            originalPrice,
            imageUrl,
            inStock: true,
            observedAt: new Date(),
            raw: { source: "hornbach-html" },
        });
    }

    return out;
}

function parseDetail(html: string, url: string): RawProduct {
    const { document } = parseHTML(html);
    const idMatch = url.match(/SH(\d+)/);
    const itemId = idMatch ? `SH${idMatch[1]}` : url;
    const name = document.querySelector("h1")?.textContent?.trim() ?? "";
    const currentPrice = parsePrice(document.querySelector(HORNBACH_SELECTORS.PRODUCT_PRICE)?.textContent);
    const originalPrice = parsePrice(document.querySelector(HORNBACH_SELECTORS.PRODUCT_OLD_PRICE)?.textContent);

    return {
        shopOrigin: HORNBACH_ORIGIN,
        slug: itemId,
        itemId,
        url,
        name,
        currentPrice,
        originalPrice,
        inStock: true,
        observedAt: new Date(),
        raw: { source: "hornbach-html-detail" },
    };
}
