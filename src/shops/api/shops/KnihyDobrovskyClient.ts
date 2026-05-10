// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/knihydobrovsky-daily/main.js

import { parseHTML } from "linkedom";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";

const ORIGIN = "knihydobrovsky.cz";
const ROOT = "https://www.knihydobrovsky.cz";

function cleanPrice(text: string | null | undefined): number | undefined {
    if (!text) {
        return undefined;
    }

    if (text.toLowerCase().includes("zdarma")) {
        return 0;
    }

    const cleaned = text.replace(/\s/g, "").replace("Kč", "").replace(",", ".");
    const n = Number.parseFloat(cleaned);
    return Number.isNaN(n) ? undefined : n;
}

export class KnihyDobrovskyClient extends ShopApiClient {
    readonly shopOrigin = ORIGIN;
    readonly displayName = "Knihy Dobrovský";
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
            loggerContext: { provider: "knihydobrovsky" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("KnihyDobrovskyClient.getProduct requires opts.url");
        }

        await this.waitTurn();
        const html = await this.getText(input.url, { signal: input.signal });
        const parsed = parseDetail(html, input.url);
        if (!parsed) {
            throw new Error(`KnihyDobrovsky could not parse product at ${input.url}`);
        }

        return parsed;
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("KnihyDobrovskyClient.listCategory requires opts.category");
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
        for (const a of Array.from(document.querySelectorAll("#main div.row-main li a"))) {
            const href = a.getAttribute("href");
            if (href === null) {
                continue;
            }

            if (
                href.includes("magnesia-litera") ||
                href.includes("velky-knizni-ctvrtek") ||
                href.includes("knihomanie")
            ) {
                continue;
            }

            const url = new URL(href, ROOT).href;
            const slug = new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "");
            const name = a.textContent?.trim() || slug;
            out.push({ id: slug, name, url });
        }

        return out;
    }
}

function parseListing(html: string): RawProduct[] {
    const { document } = parseHTML(html);
    const out: RawProduct[] = [];

    for (const item of Array.from(document.querySelectorAll("li[data-productinfo]"))) {
        const link = item.querySelector("h3 a");
        const href = link?.getAttribute("href");
        if (!href) {
            continue;
        }

        const itemUrl = new URL(href, ROOT).href;

        const itemIdMatch = href.match(/-(\d+)$/);
        const itemId = itemIdMatch ? itemIdMatch[1] : undefined;
        if (!itemId) {
            continue;
        }

        const name = item.querySelector("span.name")?.textContent?.trim() ?? "";
        if (!name) {
            continue;
        }

        const currentPriceText = item.querySelector("p.price strong")?.textContent?.trim()?.toLowerCase();
        const originalPriceText = item.querySelector(".price-before strong")?.textContent?.trim()?.toLowerCase();
        const currentPrice = cleanPrice(currentPriceText);
        const originalPrice = cleanPrice(originalPriceText);

        const buyNow = item.querySelector("a.buy-now");
        const inStock = buyNow?.textContent?.includes("Do košíku") ?? false;
        const img = item.querySelector("img");
        const imageUrl =
            img?.getAttribute("srcset")?.split(",")[0]?.trim().split(" ")[0] ?? img?.getAttribute("src") ?? undefined;

        out.push({
            shopOrigin: ORIGIN,
            slug: itemId,
            itemId,
            url: itemUrl,
            name,
            currentPrice,
            originalPrice,
            imageUrl,
            inStock,
            observedAt: new Date(),
            raw: { source: "knihydobrovsky-html" },
        });
    }

    return out;
}

function parseDetail(html: string, url: string): RawProduct | undefined {
    const listing = parseListing(html);
    if (listing.length > 0) {
        return listing[0];
    }

    const idMatch = url.match(/-(\d+)$/);
    const itemId = idMatch ? idMatch[1] : undefined;
    if (!itemId) {
        return undefined;
    }

    const { document } = parseHTML(html);
    const name = document.querySelector("h1")?.textContent?.trim() ?? "";
    if (!name) {
        return undefined;
    }

    return {
        shopOrigin: ORIGIN,
        slug: itemId,
        itemId,
        url,
        name,
        inStock: false,
        observedAt: new Date(),
        raw: { source: "knihydobrovsky-html-detail-fallback" },
    };
}
