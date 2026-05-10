// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/benu-daily/main.js

import logger from "@app/logger";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import {
    BENU_API_PRODUCT_REGEX,
    BENU_BASE_URL,
    BENU_BROWSER_UA,
    type BenuApiProduct,
    type BenuListingTile,
    type BenuRichSnippet,
} from "@app/shops/api/shops/BenuClient.types";
import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";

const BENU_ORIGIN = "benu.cz";

export class BenuClient extends ShopApiClient {
    readonly shopOrigin = BENU_ORIGIN;
    readonly displayName = "Benu CZ";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: false,
        search: false,
        botProtection: "none",
    };

    private readonly clientLog = logger.child({ component: "BenuClient", shop: BENU_ORIGIN });

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            baseUrl: BENU_BASE_URL,
            loggerContext: { provider: "benu" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            headers: { "User-Agent": BENU_BROWSER_UA, ...config.headers },
            ...config,
        });
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(BENU_BASE_URL);
        const { document } = parseHTML(html);
        const anchors = Array.from(document.querySelectorAll("div.main-menu__submenu li > a"));
        const seen = new Set<string>();
        const out: Category[] = [];
        for (const a of anchors) {
            const href = (a.getAttribute("href") ?? "").trim();
            if (!href || href === "#" || href === "/") {
                continue;
            }

            const url = href.startsWith("http") ? href : `${BENU_BASE_URL}${href}`;
            if (seen.has(url)) {
                continue;
            }

            seen.add(url);
            const id = href.startsWith("http") ? new URL(href).pathname : href;
            out.push({
                id,
                name: (a.textContent ?? "").trim() || id,
                slug: id,
                url,
            });
        }

        return out;
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("BenuClient.listCategory requires opts.category");
        }

        const limit = opts.limit ?? Number.POSITIVE_INFINITY;
        const baseCategoryUrl = opts.category.startsWith("http") ? opts.category : `${BENU_BASE_URL}${opts.category}`;

        opts.signal?.throwIfAborted();
        await this.waitTurn();
        const firstHtml = await this.getText(baseCategoryUrl, { signal: opts.signal });
        const { document: firstDoc } = parseHTML(firstHtml);

        const observedAt = new Date();
        let yielded = 0;
        for (const tile of extractListingTiles(firstDoc, baseCategoryUrl)) {
            if (yielded >= limit) {
                return;
            }

            yield tileToRawProduct(tile, baseCategoryUrl, observedAt);
            yielded++;
        }

        if (yielded >= limit) {
            return;
        }

        const pageNumbers = Array.from(firstDoc.querySelectorAll("nav.paging ul.pager li a"))
            .map((a) => Number.parseInt((a.textContent ?? "").trim(), 10))
            .filter((n) => Number.isFinite(n) && n > 1);
        const maxPage = pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1;

        for (let page = 2; page <= maxPage && yielded < limit; page++) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const url = `${baseCategoryUrl}?page=${page}`;
            const html = await this.getText(url, { signal: opts.signal });
            const { document } = parseHTML(html);
            for (const tile of extractListingTiles(document, baseCategoryUrl)) {
                if (yielded >= limit) {
                    return;
                }

                yield tileToRawProduct(tile, baseCategoryUrl, observedAt);
                yielded++;
            }
        }
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        const url = input.url ?? (input.slug ? `${BENU_BASE_URL}${input.slug}` : null);
        if (!url) {
            throw new Error("BenuClient.getProduct requires url or slug");
        }

        await this.waitTurn();
        const html = await this.getText(url);
        const { document } = parseHTML(html);

        const scriptEl = document.querySelector("#snippet-productRichSnippet-richSnippet");
        if (!scriptEl) {
            throw new Error(`BenuClient.getProduct: missing #snippet-productRichSnippet-richSnippet on ${url}`);
        }

        const snippet = SafeJSON.parse(scriptEl.textContent ?? "{}") as BenuRichSnippet;
        const itemId = snippet.identifier;
        const itemUrl = snippet.url ?? url;
        const itemName = snippet.name ?? "";
        if (!itemName) {
            throw new Error(`BenuClient.getProduct: empty name on ${url}`);
        }

        const priceRaw = snippet.offers?.price;
        const currentPrice = typeof priceRaw === "number" ? priceRaw : Number.parseFloat(String(priceRaw ?? ""));

        let originalPrice: number | undefined;
        const apiMatch = html.match(BENU_API_PRODUCT_REGEX);
        if (apiMatch) {
            const internalId = apiMatch[1];
            try {
                await this.waitTurn();
                const apiResponse = await this.get<BenuApiProduct>(
                    `${BENU_BASE_URL}/api/base/v1/products/${internalId}`
                );
                const rrp = apiResponse?.data?.attributes?.price?.rrpPrice;
                if (typeof rrp === "number" && rrp > 0 && rrp !== currentPrice) {
                    originalPrice = rrp;
                }
            } catch (err) {
                this.clientLog.warn(
                    { error: err, internalId },
                    "benu: failed to fetch /api/base/v1/products — leaving originalPrice undefined"
                );
            }
        }

        const breadcrumbs = Array.from(document.querySelectorAll("ol#breadcrumb > li > a"))
            .map((a) => (a.textContent ?? "").trim())
            .filter(Boolean);

        return {
            shopOrigin: BENU_ORIGIN,
            slug: slugFromUrl(itemUrl),
            itemId: itemId ?? undefined,
            url: itemUrl,
            name: itemName,
            imageUrl: snippet.image,
            currentPrice: Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : undefined,
            originalPrice,
            inStock: true,
            categoryPath: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            observedAt: new Date(),
            raw: { snippet, htmlLength: html.length },
        };
    }
}

function extractListingTiles(document: Document, baseUrl: string): BenuListingTile[] {
    const out: BenuListingTile[] = [];
    const links = Array.from(document.querySelectorAll(".product-list a.product-box__link"));
    for (const link of links) {
        const card = link.closest(".product-box") ?? link.parentElement;
        if (!card) {
            continue;
        }

        const href = (link.getAttribute("href") ?? "").trim();
        if (!href) {
            continue;
        }

        const itemUrl = href.startsWith("http") ? href : `${BENU_BASE_URL}${href}`;
        const titleEl = card.querySelector(".product-box__title") as Element | null;
        const itemName = (titleEl?.textContent ?? link.textContent ?? "").trim();
        if (!itemName) {
            continue;
        }

        const itemId = card.getAttribute("data-id") ?? card.querySelector("[data-id]")?.getAttribute("data-id") ?? null;
        const imageEl = card.querySelector(".product-box__image img, img") as Element | null;
        const imageSrc = imageEl?.getAttribute("src") ?? imageEl?.getAttribute("data-src") ?? null;
        const imageUrl = imageSrc ? new URL(imageSrc, baseUrl).href : null;

        const currentPriceRaw =
            card.querySelector(".product-box__price-current")?.textContent ??
            card.querySelector(".price__current")?.textContent ??
            null;
        const originalPriceRaw =
            card.querySelector(".product-box__price-old")?.textContent ??
            card.querySelector(".price__old")?.textContent ??
            null;

        const inStock = !card.querySelector(".product-box__stock-status--out, .out-of-stock");

        out.push({
            itemId,
            itemUrl,
            itemName,
            imageUrl,
            currentPrice: parseCzPrice(currentPriceRaw),
            originalPrice: parseCzPrice(originalPriceRaw),
            inStock,
        });
    }

    return out;
}

function tileToRawProduct(tile: BenuListingTile, categoryUrl: string, observedAt: Date): RawProduct {
    return {
        shopOrigin: BENU_ORIGIN,
        slug: slugFromUrl(tile.itemUrl),
        itemId: tile.itemId ?? undefined,
        url: tile.itemUrl,
        name: tile.itemName,
        imageUrl: tile.imageUrl ?? undefined,
        currentPrice: tile.currentPrice ?? undefined,
        originalPrice: tile.originalPrice ?? undefined,
        inStock: tile.inStock,
        categoryPath: [new URL(categoryUrl).pathname],
        observedAt,
        raw: tile,
    };
}

function slugFromUrl(url: string): string {
    try {
        const u = new URL(url, BENU_BASE_URL);
        const parts = u.pathname.split("/").filter((p) => p.length > 0);
        return parts[parts.length - 1] ?? u.pathname;
    } catch {
        return url;
    }
}

function parseCzPrice(raw: string | null | undefined): number | null {
    if (!raw) {
        return null;
    }

    const cleaned = raw.replace(/\s+/g, "").replace(/Kč/gi, "").replace(/,/g, ".").trim();
    if (!cleaned) {
        return null;
    }

    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) && n > 0 ? n : null;
}
