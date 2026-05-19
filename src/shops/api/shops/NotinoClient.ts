// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/notino-daily/main.js

import { logger } from "@app/logger";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type {
    NotinoApolloCache,
    NotinoCatalogVariant,
    NotinoMainMenuState,
    NotinoPricePair,
} from "@app/shops/api/shops/NotinoClient.types";
import { SafeJSON } from "@app/utils/json";
import { parseHTML } from "linkedom";

const NOTINO_ORIGIN = "notino.cz";
const ROOT = "https://www.notino.cz";

const detailLog = logger.child({ component: "NotinoClient" });

export class NotinoClient extends ShopApiClient {
    readonly shopOrigin = NOTINO_ORIGIN;
    readonly displayName = "Notino.cz";
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
            loggerContext: { provider: "notino" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("NotinoClient.getProduct requires opts.url");
        }

        await this.waitTurn();
        const html = await this.getText(input.url, { signal: input.signal });
        const products = parseProductDetail(html, input.url);
        if (products.length === 0) {
            throw new Error(`Notino product at ${input.url} returned empty Apollo state`);
        }

        return products[0];
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("NotinoClient.listCategory requires opts.category (URL slug e.g. 'damske-parfemy')");
        }

        let yielded = 0;
        let nextUrl: string | null = `${ROOT}/${opts.category}/`;

        while (nextUrl !== null) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const html = await this.getText(nextUrl, { signal: opts.signal });
            const { document } = parseHTML(html);

            const productLinks = Array.from(document.querySelectorAll("div[data-product] a"))
                .map((a) => a.getAttribute("href"))
                .filter((h): h is string => h !== null)
                .map((h) => new URL(h, ROOT).href);

            for (const link of productLinks) {
                opts.signal?.throwIfAborted();
                await this.waitTurn();
                try {
                    const detail = await this.getText(link, { signal: opts.signal });
                    for (const p of parseProductDetail(detail, link)) {
                        yield p;
                        yielded++;
                        if (opts.limit !== undefined && yielded >= opts.limit) {
                            return;
                        }
                    }
                } catch (err) {
                    detailLog.warn({ link, err }, "notino product fetch failed");
                }
            }

            const next = document.querySelector('[rel="next"]');
            const nextHref = next ? next.getAttribute("href") : null;
            nextUrl = nextHref ? new URL(nextHref, ROOT).href : null;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(`${ROOT}/`);
        const { document } = parseHTML(html);
        const scriptEl = document.querySelector('script[id="main-menu-state"]');
        if (!scriptEl) {
            return [];
        }

        const state = SafeJSON.parse(scriptEl.textContent ?? "", { strict: true }) as NotinoMainMenuState;
        const out: Category[] = [];
        for (const cat of state.fragmentContextData.DataProvider.categories) {
            if (cat.columns.length > 0) {
                for (const col of cat.columns) {
                    for (const sub of col.subCategories) {
                        if (sub.isLink && sub.link && !sub.link.includes("https")) {
                            const slug = stripSlashes(sub.link);
                            out.push({ id: slug, name: slug, url: `${ROOT}${sub.link}` });
                        }

                        for (const pt of sub.productTypes) {
                            if (!pt.link.includes("https")) {
                                const slug = stripSlashes(pt.link);
                                out.push({ id: slug, name: pt.name ?? slug, url: `${ROOT}${pt.link}` });
                            }
                        }
                    }
                }
            } else if (cat.link && !cat.link.includes("https")) {
                const slug = stripSlashes(cat.link);
                out.push({ id: slug, name: slug, url: `${ROOT}${cat.link}` });
            }
        }

        return out;
    }
}

function stripSlashes(path: string): string {
    return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function parseProductDetail(html: string, requestUrl: string): RawProduct[] {
    const { document } = parseHTML(html);
    const apolloEl = document.querySelector("#__APOLLO_STATE__");
    if (!apolloEl) {
        return [];
    }

    const apolloRaw = (apolloEl.textContent ?? "").trim().replace(/;$/, "");
    const apollo = SafeJSON.parse(apolloRaw, { strict: true }) as NotinoApolloCache;

    const variantIds: string[] = [];
    let brand = "";
    for (const key of Object.keys(apollo)) {
        if (key.startsWith("Brand:")) {
            const b = apollo[key] as { name?: string };
            if (b.name) {
                brand = b.name;
            }
        }

        if (/^CatalogVariant:\d+$/.test(key)) {
            variantIds.push(key.replace("CatalogVariant:", ""));
        }
    }

    const imageUrl = document.querySelector("#pd-image-main")?.getAttribute("src") ?? undefined;

    const out: RawProduct[] = [];
    for (const variantId of variantIds) {
        const v = apollo[`CatalogVariant:${variantId}`] as NotinoCatalogVariant | undefined;
        if (!v) {
            continue;
        }

        if (v.availability?.state !== "CanBeBought") {
            continue;
        }

        const productName = `${brand} ${v.name ?? ""} ${v.variantName ?? ""} ${v.additionalInfo ?? ""}`
            .trim()
            .replace(/\s+/g, " ");
        const { currentPrice, originalPrice } = determinePrice(v);

        out.push({
            shopOrigin: NOTINO_ORIGIN,
            slug: v.webId,
            itemId: v.webId,
            url: new URL(v.url, ROOT).href,
            name: productName,
            brand,
            currentPrice: Math.round(currentPrice),
            originalPrice: originalPrice !== undefined ? Math.round(originalPrice) : undefined,
            imageUrl,
            inStock: true,
            observedAt: new Date(),
            raw: { source: "notino-apollo", requestUrl, variant: v },
        });
    }

    return out;
}

function determinePrice(v: NotinoCatalogVariant): NotinoPricePair {
    const voucherDiscountedPrice =
        v.attributes?.VoucherDiscount?.discountedPrice ??
        v.attributes?.ConditionalVoucherDiscount?.discountConditions?.find((c) => c.productMeetsCondition)
            ?.discountedPrice;
    const price = v.price.value;
    const originalPrice = v.originalPrice?.value;
    const recentMinPrice = v.recentMinPrice?.value;

    if (voucherDiscountedPrice !== undefined) {
        return { currentPrice: voucherDiscountedPrice, originalPrice: recentMinPrice ?? price };
    }

    const original =
        recentMinPrice !== undefined &&
        originalPrice !== undefined &&
        price < recentMinPrice &&
        recentMinPrice < originalPrice
            ? recentMinPrice
            : originalPrice;
    return { currentPrice: price, originalPrice: original };
}
