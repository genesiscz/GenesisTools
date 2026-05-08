// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/mountfield-daily/main.js

import { parseHTML } from "linkedom";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";

const MOUNTFIELD_ORIGIN = "mountfield.cz";
const ROOT = "https://www.mountfield.cz";

function parsePrice(text: string | null | undefined): number | undefined {
    if (!text) {
        return undefined;
    }

    const cleaned = text.replace(/\s/g, "").replace("Kč", "").replace("€", "").replace(",", ".").trim();
    const n = Number.parseFloat(cleaned);
    return Number.isNaN(n) ? undefined : n;
}

export class MountfieldClient extends ShopApiClient {
    readonly shopOrigin = MOUNTFIELD_ORIGIN;
    readonly displayName = "Mountfield.cz";
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
            loggerContext: { provider: "mountfield" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("MountfieldClient.getProduct requires opts.url");
        }

        await this.waitTurn();
        const html = await this.getText(input.url, { signal: input.signal });
        const parsed = parseDetail(html, input.url);
        if (!parsed) {
            throw new Error(`Mountfield could not parse ${input.url}`);
        }

        return parsed;
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("MountfieldClient.listCategory requires opts.category (path slug)");
        }

        await this.waitTurn();
        const url = `${ROOT}/${opts.category}`;
        const html = await this.getText(url, { signal: opts.signal });
        const products = parseListing(html);

        let yielded = 0;
        for (const p of products) {
            yield p;
            yielded++;
            if (opts.limit !== undefined && yielded >= opts.limit) {
                return;
            }
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(`${ROOT}/`);
        const { document } = parseHTML(html);
        const out: Category[] = [];
        for (const a of Array.from(document.querySelectorAll(".list-categories__item__block"))) {
            const href = a.getAttribute("href");
            const name = a.querySelector("h3")?.textContent?.trim();
            if (href !== null && name) {
                const slug = href.replace(/^\//, "").replace(/\/$/, "");
                out.push({ id: slug, name, url: new URL(href, ROOT).href });
            }
        }

        return out;
    }
}

function parseListing(html: string): RawProduct[] {
    const { document } = parseHTML(html);
    const breadcrumbs = Array.from(document.querySelectorAll(".box-breadcrumb__item")).map(
        (el) => el.textContent?.trim() ?? ""
    );
    const out: RawProduct[] = [];

    for (const item of Array.from(document.querySelectorAll(".list-products__item__in"))) {
        const link = item.querySelector("a.list-products__item__block");
        const itemUrl = link?.getAttribute("href");
        if (!itemUrl) {
            continue;
        }

        const idMatch = itemUrl.match(/-(\d+)$/);
        const itemId = idMatch ? idMatch[1] : itemUrl.split("-").at(-1);
        if (!itemId) {
            continue;
        }

        const name = item.querySelector("h2")?.textContent?.trim() ?? "";
        if (!name) {
            continue;
        }

        const regularPriceEl = item.querySelector(".list-products__item__info__price__item--main");
        regularPriceEl?.querySelector("span")?.remove();
        const regularPrice = parsePrice(regularPriceEl?.textContent);

        const oldPriceEl = item.querySelector(".list-products__item__info__price__item--old");
        oldPriceEl?.querySelector("span")?.remove();
        const oldPrice = parsePrice(oldPriceEl?.textContent);

        const futurePriceEl = item.querySelector(".box__future-price__list strong");
        const futurePrice = parsePrice(futurePriceEl?.textContent);
        const originalPrice = oldPrice ?? futurePrice;

        const loyaltyEl = item.querySelector(".list-products__item__loyalty__link .in-loyalty__highlight");
        const loyaltyPrice = parsePrice(loyaltyEl?.textContent);

        let currentPrice = regularPrice;
        let finalOriginal = originalPrice;
        if (originalPrice === undefined && loyaltyPrice !== undefined && regularPrice !== undefined) {
            finalOriginal = regularPrice;
            currentPrice = loyaltyPrice;
        }

        const img = item.querySelector("img");
        const imageUrl = img?.getAttribute("data-src") ?? img?.getAttribute("src") ?? undefined;

        out.push({
            shopOrigin: MOUNTFIELD_ORIGIN,
            slug: itemId,
            itemId,
            url: new URL(itemUrl, ROOT).href,
            name,
            currentPrice,
            originalPrice: finalOriginal,
            imageUrl,
            inStock: true,
            categoryPath: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            observedAt: new Date(),
            raw: { source: "mountfield-html" },
        });
    }

    return out;
}

function parseDetail(html: string, url: string): RawProduct | undefined {
    const products = parseListing(html);
    if (products.length > 0) {
        return products[0];
    }

    const id = url.match(/-(\d+)$/)?.[1];
    const { document } = parseHTML(html);
    const name = document.querySelector("h1")?.textContent?.trim();
    if (!id || !name) {
        return undefined;
    }

    return {
        shopOrigin: MOUNTFIELD_ORIGIN,
        slug: id,
        itemId: id,
        url,
        name,
        inStock: true,
        observedAt: new Date(),
        raw: { source: "mountfield-html-detail-fallback" },
    };
}
