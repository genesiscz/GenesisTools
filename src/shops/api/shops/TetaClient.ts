// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/tetadrogerie-daily/main.js

import { parseHTML } from "linkedom";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type { TetaCategoryListingResponse, TetaRawProduct, TetaTaxon } from "@app/shops/api/shops/TetaClient.types";

const TETA_ORIGIN = "tetadrogerie.cz";
const STORE_ROOT = "https://www.tetadrogerie.cz";
const API_ROOT = "https://be.tetadrogerie.cz";
const PAGE_SIZE = 40;
const IMAGE_BASE = "https://teta-drogerie.fra1.digitaloceanspaces.com/cache/inveocz_product_gallery";
const MULTI_DISCOUNT_RE = /za\s+.*ks\s+při\s+koupi.*\s+ks/i;

export class TetaClient extends ShopApiClient {
    readonly shopOrigin = TETA_ORIGIN;
    readonly displayName = "Teta Drogerie";
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
            baseUrl: STORE_ROOT,
            loggerContext: { provider: "teta" },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 1.5,
            headers: { Origin: STORE_ROOT, ...(config.headers ?? {}) },
            ...config,
        });
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        throw new Error(`TetaClient.getProduct: not implemented in Phase 2 (input=${input.url ?? input.slug})`);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("TetaClient.listCategory requires opts.category (taxon slug like 'krasa-a-zdravi')");
        }

        let yielded = 0;
        let page = 1;
        let lastPage = 1;
        while (page <= lastPage) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const listing = await this.get<TetaCategoryListingResponse>(
                `${API_ROOT}/api/v2/shop/search/products-variants`,
                {
                    params: {
                        taxon: opts.category,
                        page,
                        itemsPerPage: PAGE_SIZE,
                        sort: "asc",
                        order_by: "price",
                        strana: page,
                    },
                    signal: opts.signal,
                }
            );
            const items = listing.items ?? [];
            if (items.length === 0) {
                return;
            }

            for (const item of items) {
                yield this.toRawProduct(item);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            const totalItems = listing.pagination?.totalItems;
            const itemsPerPage = listing.pagination?.itemsPerPage ?? PAGE_SIZE;
            lastPage = totalItems !== undefined ? Math.ceil(totalItems / itemsPerPage) : page;
            page++;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const html = await this.getText(`${STORE_ROOT}/eshop/`);
        const { document } = parseHTML(html);
        const links = Array.from(document.querySelectorAll(".c-main-menu .c-menu-item__link-wrapper > a"));
        const out: Category[] = [];
        for (const a of links) {
            const href = a.getAttribute("href") ?? "";
            const m = href.match(/\/eshop\/produkty\/([a-z0-9-]+)/);
            if (!m) {
                continue;
            }

            const slug = m[1];
            out.push({
                id: slug,
                name: (a.textContent ?? "").trim() || slug,
                slug,
                url: new URL(href, STORE_ROOT).href,
            });
        }

        return out;
    }

    private toRawProduct(p: TetaRawProduct): RawProduct {
        const itemId = p.code.replace(/^0+/, "") || p.code;
        const slug = p.slug;
        const url = `${STORE_ROOT}/eshop/produkty/${slug}`;
        const name = (p.name ?? "").replace(/<[^>]*>/g, "").trim();
        const breadcrumbs = buildBreadcrumb(p.taxa ?? []);

        const isMultiDiscount = MULTI_DISCOUNT_RE.test(p.bbyPrices?.conditions ?? "");
        const acmd = halvesToCZK(p.bbyPrices?.acmd);
        const zcmd = halvesToCZK(p.bbyPrices?.zcmd);
        const fallbackPrice = halvesToCZK(p.currentPrice ?? p.price);
        const fallbackOriginal = halvesToCZK(p.originalPrice);
        let currentPrice: number | undefined;
        let originalPrice: number | undefined;
        if (isMultiDiscount) {
            currentPrice = zcmd ?? fallbackOriginal ?? fallbackPrice;
            originalPrice = undefined;
        } else {
            currentPrice = acmd ?? fallbackPrice;
            if (zcmd !== undefined && acmd !== undefined && zcmd !== acmd) {
                originalPrice = zcmd;
            } else if (fallbackOriginal !== undefined && fallbackOriginal !== fallbackPrice) {
                originalPrice = fallbackOriginal;
            }
        }

        return {
            shopOrigin: TETA_ORIGIN,
            slug,
            itemId,
            url,
            name,
            imageUrl: p.image ? `${IMAGE_BASE}/${p.image}` : undefined,
            categoryPath: breadcrumbs.length > 0 ? breadcrumbs : undefined,
            currentPrice,
            originalPrice,
            inStock: p.isStockAvailable,
            observedAt: new Date(),
            raw: p,
        };
    }
}

function halvesToCZK(value: number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    return Math.round(value) / 100;
}

function buildBreadcrumb(taxa: TetaTaxon[]): string[] {
    const categoryTaxa = taxa.filter((t) => t.parent.code !== "article_brands");
    if (categoryTaxa.length === 0) {
        return [];
    }

    const byCode = new Map<string, TetaTaxon>();
    for (const t of categoryTaxa) {
        byCode.set(t.code, t);
    }

    const root = categoryTaxa.find((t) => !byCode.has(t.parent.code)) ?? categoryTaxa[0];
    const path: string[] = [];
    let cursor: TetaTaxon | undefined = root;
    let guard = 0;
    while (cursor && guard < 100) {
        path.push(cursor.name);
        const child: TetaTaxon | undefined = categoryTaxa.find((t) => t.parent.code === cursor!.code);
        cursor = child;
        guard++;
    }

    return path;
}
