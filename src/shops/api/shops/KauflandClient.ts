// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/kaufland-daily/main.js

import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import type { KauflandJsonLdProduct, KauflandParsedProduct } from "./KauflandClient.types";

const KAUFLAND_ORIGIN = "kaufland.cz";
const ROOT = "https://www.kaufland.cz";

export class KauflandClient extends ShopApiClient {
    readonly shopOrigin = KAUFLAND_ORIGIN;
    readonly displayName = "Kaufland.cz";
    readonly currency = "CZK";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: false,
        search: false,
        botProtection: "soft",
    };

    constructor(config: ShopApiClientConstructorConfig = {}) {
        super({
            baseUrl: ROOT,
            loggerContext: { provider: "kaufland" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("KauflandClient.getProduct requires url (HTML scrape, no batch endpoint)");
        }

        await this.waitTurn();
        const html = await this.getText(input.url);
        const { document } = parseHTML(html);
        const ldText = Array.from(document.querySelectorAll("script[type='application/ld+json']"))
            .map((n) => n.textContent ?? "")
            .find((t) => t.includes('"@type":"Product"'));
        if (!ldText) {
            throw new Error(`Kaufland product page ${input.url} has no JSON-LD Product`);
        }

        const parsed = SafeJSON.parse(ldText) as KauflandJsonLdProduct | KauflandJsonLdProduct[];
        const ld = Array.isArray(parsed) ? parsed[0] : parsed;
        const slug = this.parseUrl(input.url).slug;
        return ldToRawProduct(ld, slug, input.url, []);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("KauflandClient.listCategory requires opts.category");
        }

        const firstUrl = `${ROOT}/category/${opts.category}/`;
        let yielded = 0;
        let pageNumber = 1;
        let totalProducts: number | undefined;
        let pageProductCount = 0;
        while (true) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const url = pageNumber === 1 ? firstUrl : `${ROOT}/category/${opts.category}/p${pageNumber}/`;
            const html = await this.getText(url, { signal: opts.signal });
            const parsed = extractProductsFromCategoryHtml(html);
            if (parsed.products.length === 0) {
                return;
            }

            for (const product of parsed.products) {
                yield parsedToRawProduct(product);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            if (totalProducts === undefined) {
                totalProducts = parsed.totalProducts;
                pageProductCount = parsed.products.length;
            }

            if (totalProducts === undefined || pageProductCount === 0) {
                return;
            }

            const totalPages = Math.ceil(totalProducts / pageProductCount);
            if (pageNumber >= totalPages) {
                return;
            }

            pageNumber++;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(`${ROOT}/`);
        const { document } = parseHTML(html);
        const links = Array.from(document.querySelectorAll("li.rd-footer_navigation-link-list-item > a"));
        return links.map((a) => {
            const name = (a.textContent ?? "").trim();
            const href = a.getAttribute("href") ?? "";
            return {
                id: name,
                name,
                url: new URL(href, ROOT).href,
            };
        });
    }
}

interface ExtractedProducts {
    products: KauflandParsedProduct[];
    totalProducts?: number;
}

function extractProductsFromCategoryHtml(html: string): ExtractedProducts {
    const { document } = parseHTML(html);
    const articles = Array.from(document.querySelectorAll("article.product:not(:has(.product__sponsored-ad-label))"));
    if (articles.length === 0) {
        return { products: [] };
    }

    const ldScripts = Array.from(document.querySelectorAll("script[data-n-head]"))
        .map((n) => n.textContent ?? "")
        .filter((t) => t.includes('"@type":"Product"'));
    const ldProducts: KauflandJsonLdProduct[] = ldScripts.flatMap((s) => {
        try {
            const v = SafeJSON.parse(s);
            return Array.isArray(v) ? v : [v];
        } catch {
            return [];
        }
    });
    const ldByImgKey = new Map<string, KauflandJsonLdProduct>();
    for (const p of ldProducts) {
        const img = Array.isArray(p.image) ? p.image[0] : p.image;
        if (!img) {
            continue;
        }

        ldByImgKey.set(imgKey(img), p);
    }

    const products: KauflandParsedProduct[] = [];
    for (const article of articles) {
        const titleEl = article.querySelector(".product__title");
        const sourceEl = article.querySelector("source");
        if (!titleEl || !sourceEl) {
            continue;
        }

        const itemName = (titleEl.textContent ?? "").trim();
        const img = (sourceEl.getAttribute("srcset") ?? "").trim();
        const meta = ldByImgKey.get(imgKey(img));
        if (!meta) {
            continue;
        }

        const rrpEl = article.querySelector(".price-note--rrp");
        const originalPrice = rrpEl ? cleanPrice(rrpEl.textContent ?? "") : undefined;
        products.push({
            itemId: String(meta.sku),
            itemUrl: meta.offers.url,
            itemName,
            img,
            currentPrice: Number.parseFloat(String(meta.offers.price)),
            originalPrice: originalPrice ?? undefined,
            discounted: originalPrice !== undefined,
            inStock: meta.offers.availability === "https://schema.org/InStock",
            categoryPath: [],
        });
    }

    let totalProducts: number | undefined;
    const countEl = document.querySelector(".product-count");
    if (countEl) {
        const num = (countEl.textContent ?? "").replace(/\s+/g, "");
        const parsedCount = Number.parseInt(num, 10);
        if (Number.isFinite(parsedCount)) {
            totalProducts = parsedCount;
        }
    }

    return { products, totalProducts };
}

function imgKey(imgUrl: string): string {
    const parts = imgUrl.split("/");
    return parts[parts.length - 1] ?? "";
}

function cleanPrice(text: string): number | undefined {
    const cleaned = text
        .replace(/[^\d,.\s]/g, "")
        .replace(/\s+/g, "")
        .replace(/,/g, ".");
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : undefined;
}

function parsedToRawProduct(p: KauflandParsedProduct): RawProduct {
    const slug = slugFromUrl(p.itemUrl);
    return {
        shopOrigin: KAUFLAND_ORIGIN,
        slug,
        itemId: p.itemId,
        url: p.itemUrl,
        name: p.itemName,
        imageUrl: p.img,
        currentPrice: p.currentPrice,
        originalPrice: p.originalPrice,
        inStock: p.inStock,
        categoryPath: p.categoryPath.length > 0 ? p.categoryPath : undefined,
        observedAt: new Date(),
        raw: p,
    };
}

function ldToRawProduct(ld: KauflandJsonLdProduct, slug: string, url: string, categoryPath: string[]): RawProduct {
    const img = Array.isArray(ld.image) ? ld.image[0] : ld.image;
    return {
        shopOrigin: KAUFLAND_ORIGIN,
        slug,
        itemId: String(ld.sku),
        url,
        name: ld.name,
        imageUrl: img,
        currentPrice: Number.parseFloat(String(ld.offers.price)),
        inStock: ld.offers.availability === "https://schema.org/InStock",
        categoryPath: categoryPath.length > 0 ? categoryPath : undefined,
        observedAt: new Date(),
        raw: ld,
    };
}

function slugFromUrl(url: string): string {
    try {
        const u = new URL(url, ROOT);
        const parts = u.pathname.split("/").filter((p) => p.length > 0);
        return parts[parts.length - 1] ?? url;
    } catch {
        return url;
    }
}
