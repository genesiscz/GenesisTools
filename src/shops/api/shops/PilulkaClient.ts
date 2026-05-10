// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/pilulka-daily/main.js

import logger from "@app/logger";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type { PilulkaProductLD } from "@app/shops/api/shops/PilulkaClient.types";
import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";

const PILULKA_ORIGIN = "pilulka.cz";
const ROOT = "https://www.pilulka.cz";

const detailLog = logger.child({ component: "PilulkaClient" });

function parseFloatText(s: string | null | undefined): number | undefined {
    if (!s) {
        return undefined;
    }

    const cleaned = s.replace(/\s/g, "").replace("Kč", "").replace("€", "").replace(",", ".");
    const n = Number.parseFloat(cleaned);
    return Number.isNaN(n) ? undefined : n;
}

export class PilulkaClient extends ShopApiClient {
    readonly shopOrigin = PILULKA_ORIGIN;
    readonly displayName = "Pilulka.cz";
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
            loggerContext: { provider: "pilulka" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("PilulkaClient.getProduct requires opts.url");
        }

        await this.waitTurn();
        const html = await this.getText(input.url, { signal: input.signal });
        const parsed = parseDetail(html, input.url);
        if (!parsed) {
            throw new Error(`Pilulka could not parse product at ${input.url}`);
        }

        return parsed;
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("PilulkaClient.listCategory requires opts.category");
        }

        let url: string | null = `${ROOT}/${opts.category}`;
        let yielded = 0;

        while (url !== null) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const html: string = await this.getText(url, { signal: opts.signal });
            const { document } = parseHTML(html);

            const productLinks = extractProductLinks(document);

            for (const link of productLinks) {
                opts.signal?.throwIfAborted();
                await this.waitTurn();
                try {
                    const detail = await this.getText(link, { signal: opts.signal });
                    const parsed = parseDetail(detail, link);
                    if (parsed) {
                        yield parsed;
                        yielded++;
                        if (opts.limit !== undefined && yielded >= opts.limit) {
                            return;
                        }
                    }
                } catch (err) {
                    detailLog.warn({ link, err }, "pilulka product fetch failed");
                }
            }

            const nextHref = document.querySelector(".page-item--next a")?.getAttribute("href");
            url = nextHref ? new URL(nextHref, ROOT).href : null;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(`${ROOT}/`);
        const { document } = parseHTML(html);
        const out: Category[] = [];
        for (const a of Array.from(document.querySelectorAll(".menu__href"))) {
            const href = a.getAttribute("href");
            const name = a.textContent?.trim();
            if (href !== null && name) {
                const slug = href.replace(/^\//, "").replace(/\/$/, "");
                out.push({ id: slug, name, url: new URL(href, ROOT).href });
            }
        }

        return out;
    }
}

function parseDetail(html: string, url: string): RawProduct | undefined {
    const { document } = parseHTML(html);
    const ldEl = document.querySelector("script[type='application/ld+json']");
    if (!ldEl) {
        return undefined;
    }

    const ldRaw = ldEl.textContent ?? "[]";
    const data = SafeJSON.parse(ldRaw) as PilulkaProductLD | PilulkaProductLD[];
    const arr = Array.isArray(data) ? data : [data];
    const product = arr.find((x) => x["@type"] === "Product");
    if (!product || product.offers?.price === undefined) {
        return undefined;
    }

    const inStock = product.offers.availability === "https://schema.org/InStock";
    const imageUrl = Array.isArray(product.image) ? product.image[0] : product.image;
    const idEl = document.querySelector("[componentname='catalog.product']");
    const itemId = idEl?.getAttribute("id");
    if (!itemId) {
        return undefined;
    }

    const oldPriceText = document.querySelector(".product-price-container .product-card-price__old")?.textContent ?? "";
    const oldPrice = parseFloatText(oldPriceText);
    const giftPriceText = document.querySelector(".giftEvents__price__price")?.textContent ?? "";
    const giftElement = document.querySelector(".giftEvents__item");
    const hasCouponPrice =
        Boolean(giftPriceText) && giftElement !== null && !/pro\s+členy\s+Pilulka/i.test(giftElement.textContent ?? "");

    let currentPrice: number = product.offers.price;
    let originalPrice: number | undefined;
    if (hasCouponPrice) {
        currentPrice = parseFloatText(giftPriceText) ?? product.offers.price;
        originalPrice = oldPrice ?? product.offers.price;
    } else if (oldPrice !== undefined && oldPrice > 0) {
        const priceWithCodeText = document.querySelector(".price-with-code__price")?.textContent ?? "";
        const priceWithCode = parseFloatText(priceWithCodeText);
        currentPrice = priceWithCode ?? product.offers.price;
        originalPrice = oldPrice;
    }

    const categoryPath = product.category?.split(" / ");

    return {
        shopOrigin: PILULKA_ORIGIN,
        slug: itemId,
        itemId,
        url,
        name: product.name,
        currentPrice,
        originalPrice,
        imageUrl: typeof imageUrl === "string" ? imageUrl : undefined,
        inStock,
        categoryPath,
        observedAt: new Date(),
        raw: { source: "pilulka-jsonld", ld: product },
    };
}

function extractProductLinks(document: ReturnType<typeof parseHTML>["document"]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of Array.from(document.querySelectorAll(".product-list__item"))) {
        const href = item.querySelector("a")?.getAttribute("href");
        if (!href || !href.startsWith("/")) {
            continue;
        }

        const absolute = new URL(href, ROOT).href;
        if (seen.has(absolute)) {
            continue;
        }

        seen.add(absolute);
        out.push(absolute);
    }

    return out;
}
