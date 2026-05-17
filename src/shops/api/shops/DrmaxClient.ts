// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/drmax-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import {
    DRMAX_BASE_URL,
    DRMAX_BROWSER_UA,
    DRMAX_SITEMAP_URL,
    type DrmaxJsonLdProduct,
    type DrmaxParsedTile,
} from "@app/shops/api/shops/DrmaxClient.types";
import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";

const DRMAX_ORIGIN = "drmax.cz";

export class DrmaxClient extends ShopApiClient {
    readonly shopOrigin = DRMAX_ORIGIN;
    readonly displayName = "Dr.Max CZ";
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
        // Destructure `headers` so the trailing `...rest` spread cannot clobber
        // our default User-Agent. Previously `...config` overwrote the merged
        // headers object whenever the caller passed `headers` themselves.
        const { headers, ...rest } = config;
        super({
            baseUrl: DRMAX_BASE_URL,
            loggerContext: { provider: "drmax" },
            rateLimitPerSecond: rest.rateLimitPerSecond ?? 1.5,
            ...rest,
            headers: { "User-Agent": DRMAX_BROWSER_UA, ...headers },
        });
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const xml = await this.getText(DRMAX_SITEMAP_URL);
        const out: Category[] = [];
        const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
        const seen = new Set<string>();
        for (const m of matches) {
            const href = (m[1] ?? "").trim();
            if (!href.includes("drmax.cz")) {
                continue;
            }

            if (seen.has(href)) {
                continue;
            }

            seen.add(href);
            const u = new URL(href);
            out.push({
                id: u.pathname,
                name: u.pathname,
                slug: u.pathname,
                url: href,
            });
        }

        return out;
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("DrmaxClient.listCategory requires opts.category (category URL or pathname)");
        }

        const limit = opts.limit ?? Number.POSITIVE_INFINITY;
        let url = opts.category.startsWith("http") ? opts.category : `${DRMAX_BASE_URL}${opts.category}`;
        let yielded = 0;
        const visited = new Set<string>();

        while (url && yielded < limit) {
            if (visited.has(url)) {
                return;
            }

            visited.add(url);
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const html = await this.getText(url, { signal: opts.signal });
            const { document } = parseHTML(html);

            const tiles = Array.from(
                document.querySelectorAll('[data-test-id="product_grid"] [data-test-id="category-tile-product"]')
            );
            const observedAt = new Date();
            for (const tile of tiles) {
                if (yielded >= limit) {
                    return;
                }

                const parsed = parseDrmaxTile(tile, url);
                if (!parsed) {
                    continue;
                }

                yield tileToRawProduct(parsed, url, observedAt);
                yielded++;
            }

            const nextHref = document.querySelector(".page-next a")?.getAttribute("href") ?? null;
            if (!nextHref) {
                return;
            }

            url = nextHref.startsWith("http") ? nextHref : new URL(nextHref, DRMAX_BASE_URL).href;
        }
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        const url = input.url ?? (input.slug ? slugToProductUrl(input.slug) : null);
        if (!url) {
            throw new Error("DrmaxClient.getProduct requires url or slug");
        }

        await this.waitTurn();
        const html = await this.getText(url);
        const { document } = parseHTML(html);

        const ldBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        let parsed: DrmaxJsonLdProduct | null = null;
        for (const block of ldBlocks) {
            const text = block.textContent ?? "";
            if (!text.trim()) {
                continue;
            }

            try {
                const data = SafeJSON.parse(text) as DrmaxJsonLdProduct | DrmaxJsonLdProduct[];
                const candidates = Array.isArray(data) ? data : [data];
                for (const c of candidates) {
                    if (c?.["@type"] === "Product" && c.offers) {
                        parsed = c;
                        break;
                    }
                }

                if (parsed) {
                    break;
                }
            } catch {
                // Malformed JSON-LD block — skip and try next.
            }
        }

        if (!parsed?.name) {
            throw new Error(`DrmaxClient.getProduct: no JSON-LD Product on ${url}`);
        }

        // Schema.org offers may be a single Offer or an Offer[] — normalize.
        const offer = Array.isArray(parsed.offers) ? parsed.offers[0] : parsed.offers;
        const priceRaw = offer?.price;
        const currentPrice = typeof priceRaw === "number" ? priceRaw : Number.parseFloat(String(priceRaw ?? ""));
        const imageUrl = Array.isArray(parsed.image) ? parsed.image[0] : parsed.image;
        const inStock = offer?.availability?.includes("InStock") ?? true;

        const breadcrumbs = Array.from(document.querySelectorAll("ol.breadcrumb li a, nav.breadcrumb a"))
            .map((a) => (a.textContent ?? "").trim())
            .filter(Boolean);

        return {
            shopOrigin: DRMAX_ORIGIN,
            slug: slugFromUrl(url),
            itemId: parsed.sku ?? undefined,
            url,
            name: parsed.name,
            imageUrl,
            currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : undefined,
            inStock,
            categoryPath: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            // gtin13 from JSON-LD is intentionally NOT copied into RawProduct.ean
            // (cap_ean=false). See Plan 06 §"Capabilities locked" for rationale.
            observedAt: new Date(),
            raw: { ldProduct: parsed, htmlLength: html.length },
        };
    }
}

function parseDrmaxTile(tile: Element, pageUrl: string): DrmaxParsedTile | null {
    const link = tile.querySelector('[data-test-id="category-tile-product-link"] a');
    const titleEl = tile.querySelector('[data-test-id="category-tile-product-name"]');
    const priceBox = tile.querySelector('[data-test-id="category-tile-product-price"]');
    const meta = tile.querySelector("meta");

    const href = link?.getAttribute("href");
    if (!href) {
        return null;
    }

    const itemUrl = new URL(href, pageUrl).href;
    const itemName = (titleEl?.textContent ?? "").trim();
    if (!itemName) {
        return null;
    }

    const itemId = meta?.getAttribute("content") ?? null;
    const imageSrc = tile.querySelector("img")?.getAttribute("src") ?? null;
    const imageUrl = imageSrc ? new URL(imageSrc, pageUrl).href : null;
    const shortDesc = (tile.querySelector(".tile__desc")?.textContent ?? "").trim() || null;

    const currentPriceRaw = (priceBox?.childNodes?.[0]?.textContent ?? "").trim();
    const currentPrice = parseCzPrice(currentPriceRaw);
    const originalPriceRaw = (priceBox?.querySelector(".tile__price__before")?.textContent ?? "").trim();
    const originalPrice = parseCzPrice(originalPriceRaw);

    const outOfStock = !!tile.querySelector(".product__out-of-stock");

    return {
        itemId,
        itemUrl,
        itemName,
        shortDesc,
        imageUrl,
        currentPrice,
        originalPrice,
        inStock: !outOfStock,
    };
}

function tileToRawProduct(tile: DrmaxParsedTile, pageUrl: string, observedAt: Date): RawProduct {
    return {
        shopOrigin: DRMAX_ORIGIN,
        slug: slugFromUrl(tile.itemUrl),
        itemId: tile.itemId ?? undefined,
        url: tile.itemUrl,
        name: tile.itemName,
        imageUrl: tile.imageUrl ?? undefined,
        currentPrice: tile.currentPrice ?? undefined,
        originalPrice: tile.originalPrice ?? undefined,
        inStock: tile.inStock,
        categoryPath: [new URL(pageUrl).pathname],
        observedAt,
        raw: tile,
    };
}

function slugFromUrl(url: string): string {
    try {
        const u = new URL(url, DRMAX_BASE_URL);
        const parts = u.pathname.split("/").filter((p) => p.length > 0);
        return parts[parts.length - 1] ?? u.pathname;
    } catch {
        return url;
    }
}

/**
 * Round-trip a slug back to a Dr.Max product URL.
 *
 * `slugFromUrl()` returns the LAST path segment (no leading slash), while
 * `listCategory` may emit fully-qualified URLs. Callers that pass the value
 * back as `slug` need each shape coerced into a real URL — otherwise we'd
 * concatenate `${DRMAX_BASE_URL}${slug}` and produce e.g.
 * `https://www.drmax.czmy-product` (broken).
 */
function slugToProductUrl(slug: string): string {
    if (slug.startsWith("http://") || slug.startsWith("https://")) {
        return slug;
    }

    if (slug.startsWith("/")) {
        return `${DRMAX_BASE_URL}${slug}`;
    }

    return `${DRMAX_BASE_URL}/${slug}`;
}

function parseCzPrice(raw: string | null | undefined): number | null {
    if (!raw) {
        return null;
    }

    const cleaned = raw.replace(/ /g, " ").replace(/\s+/g, "").replace(/Kč/gi, "").replace(/,/g, ".").trim();
    if (!cleaned) {
        return null;
    }

    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
}
