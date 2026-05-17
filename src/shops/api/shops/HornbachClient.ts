// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/hornbach-daily/main.js
// Hornbach renders product listings into a window.__APOLLO_STATE__ object
// keyed by ROOT_QUERY.categoryListing(...). HTML data-testid attributes were
// renamed product-* → article-* in 2026 and prices moved off the DOM, so the
// reliable extraction path is the inlined Apollo state (matches the actor).

import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import {
    HORNBACH_SELECTORS,
    type HornbachApolloCategoryListing,
    type HornbachApolloProduct,
    type HornbachApolloState,
} from "@app/shops/api/shops/HornbachClient.types";
import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";

const HORNBACH_ORIGIN = "hornbach.cz";
const ROOT = "https://www.hornbach.cz";

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
        const apollo = extractApolloState(html);
        const detail = apollo ? findDetailProduct(apollo, input.url) : undefined;
        if (detail) {
            return toRawProduct(detail);
        }

        return parseDetailFallback(html, input.url);
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
        const seen = new Set<string>();
        for (const a of Array.from(document.querySelectorAll(HORNBACH_SELECTORS.TOP_CATEGORIES))) {
            const href = a.getAttribute("href");
            const name = a.getAttribute("title") ?? a.textContent?.trim();
            if (!href || !name) {
                continue;
            }

            if (!/^\/c\//.test(href)) {
                continue;
            }

            const url = new URL(href, ROOT).href;
            const slug = new URL(url).pathname.replace(/^\/c\//, "").replace(/\/$/, "");
            if (seen.has(slug)) {
                continue;
            }

            seen.add(slug);
            out.push({ id: slug, name, url });
        }

        return out;
    }
}

function extractApolloState(html: string): HornbachApolloState | undefined {
    const start = html.indexOf("window.__APOLLO_STATE__");
    if (start < 0) {
        return undefined;
    }

    const eqIdx = html.indexOf("=", start);
    const braceStart = html.indexOf("{", eqIdx);
    if (eqIdx < 0 || braceStart < 0) {
        return undefined;
    }

    const next = html.indexOf("window.__", braceStart + 1);
    const slice = next > 0 ? html.slice(braceStart, next) : html.slice(braceStart);
    const lastBrace = slice.lastIndexOf("}") + 1;
    if (lastBrace <= 0) {
        return undefined;
    }

    try {
        const parsed: unknown = SafeJSON.parse(slice.slice(0, lastBrace), { strict: true });
        if (typeof parsed === "object" && parsed !== null) {
            return parsed as HornbachApolloState;
        }

        return undefined;
    } catch {
        return undefined;
    }
}

function findCategoryListing(apollo: HornbachApolloState): HornbachApolloCategoryListing | undefined {
    const root = apollo.ROOT_QUERY;
    if (!root) {
        return undefined;
    }

    for (const key of Object.keys(root)) {
        if (!key.includes("categoryListing")) {
            continue;
        }

        const value = root[key] as HornbachApolloCategoryListing;
        if (Array.isArray(value?.itemList)) {
            return value;
        }
    }

    return undefined;
}

function findDetailProduct(apollo: HornbachApolloState, url: string): HornbachApolloProduct | undefined {
    const idMatch = url.match(/\/(\d+)\/?(?:\?|$)/);
    const productId = idMatch?.[1];
    const root = apollo.ROOT_QUERY;
    if (!root) {
        return undefined;
    }

    for (const key of Object.keys(root)) {
        const value = root[key];
        if (!value || typeof value !== "object") {
            continue;
        }

        const product = value as HornbachApolloProduct;
        if (product.abstractProductId && (productId === undefined || product.abstractProductId === productId)) {
            return product;
        }
    }

    return undefined;
}

function parseListing(html: string): RawProduct[] {
    const apollo = extractApolloState(html);
    if (!apollo) {
        return [];
    }

    const listing = findCategoryListing(apollo);
    if (!listing?.itemList) {
        return [];
    }

    const breadcrumbs = listing.category?.name ? [listing.category.name] : undefined;
    const out: RawProduct[] = [];
    for (const item of listing.itemList) {
        if (!item.abstractProductId) {
            continue;
        }

        const raw = toRawProduct(item);
        if (breadcrumbs && raw.categoryPath === undefined) {
            raw.categoryPath = breadcrumbs;
        }

        out.push(raw);
    }

    return out;
}

function toRawProduct(item: HornbachApolloProduct): RawProduct {
    const itemId = item.abstractProductId ?? "";
    const url = item.url ? new URL(item.url, ROOT).href : ROOT;
    const imageUrl = item.mainImage?.url ?? item.mainImage?.thumbnailUrl;
    const currentPrice = item.defaultPrice?.price;
    return {
        shopOrigin: HORNBACH_ORIGIN,
        slug: itemId,
        itemId,
        url,
        name: item.title ?? "",
        currentPrice,
        imageUrl,
        inStock: true,
        observedAt: new Date(),
        raw: item,
    };
}

function parseDetailFallback(html: string, url: string): RawProduct {
    const { document } = parseHTML(html);
    const idMatch = url.match(/\/(\d+)\/?(?:\?|$)/);
    const itemId = idMatch ? idMatch[1] : url;
    const name = document.querySelector("h1")?.textContent?.trim() ?? "";
    return {
        shopOrigin: HORNBACH_ORIGIN,
        slug: itemId,
        itemId,
        url,
        name,
        inStock: true,
        observedAt: new Date(),
        raw: { source: "hornbach-html-detail-fallback" },
    };
}
