// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/dm-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import type {
    DmCategoryResponse,
    DmNavigationNode,
    DmNavigationResponse,
    DmProductListingResponse,
    DmRawProduct,
} from "./DmClient.types";

export type DmCountry = "CZ" | "SK";

interface DmCountryConfig {
    shopOrigin: string;
    displayName: string;
    currency: string;
    storeRoot: string;
    contentBase: string;
    searchBase: string;
    loggerProvider: string;
}

const DM_COUNTRY_CONFIGS: Record<DmCountry, DmCountryConfig> = {
    CZ: {
        shopOrigin: "dm.cz",
        displayName: "dm.cz",
        currency: "CZK",
        storeRoot: "https://www.dm.cz",
        contentBase: "https://content.services.dmtech.com/rootpage-dm-shop-cs-cz",
        searchBase: "https://product-search.services.dmtech.com/cz/search/static",
        loggerProvider: "dm",
    },
    SK: {
        shopOrigin: "mojadm.sk",
        displayName: "Moja DM",
        currency: "EUR",
        storeRoot: "https://www.mojadm.sk",
        contentBase: "https://content.services.dmtech.com/rootpage-dm-shop-sk-sk",
        searchBase: "https://product-search.services.dmtech.com/sk/search/static",
        loggerProvider: "mojadm",
    },
};

const PAGE_SIZE = 60;

export interface DmClientConfig extends ShopApiClientConstructorConfig {
    country?: DmCountry;
}

export class DmClient extends ShopApiClient {
    readonly shopOrigin: string;
    readonly displayName: string;
    readonly currency: string;
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: true,
        search: false,
        botProtection: "none",
    };

    protected readonly storeRoot: string;
    protected readonly contentBase: string;
    protected readonly searchBase: string;

    constructor(config: DmClientConfig = {}) {
        const { country = "CZ", ...rest } = config;
        const countryConfig = DM_COUNTRY_CONFIGS[country];
        super({
            baseUrl: countryConfig.storeRoot,
            loggerContext: { provider: countryConfig.loggerProvider },
            // The dm `product-search.services.dmtech.com` search API
            // returns "Too many requests! ...searchapi-support@dm.de" at
            // ~2 req/s sustained. 1/s clears 1000-item runs reliably.
            rateLimitPerSecond: rest.rateLimitPerSecond ?? 1,
            ...rest,
        });
        this.shopOrigin = countryConfig.shopOrigin;
        this.displayName = countryConfig.displayName;
        this.currency = countryConfig.currency;
        this.storeRoot = countryConfig.storeRoot;
        this.contentBase = countryConfig.contentBase;
        this.searchBase = countryConfig.searchBase;
    }

    async getProduct(input: { url?: string; slug?: string }): Promise<RawProduct> {
        throw new Error(
            `DmClient.getProduct: not implemented in Phase 2; use listCategory or tools shops get instead (input=${input.url ?? input.slug})`
        );
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error(
                "DmClient.listCategory requires opts.category (slug like 'dekorativni-kosmetika/oci/rasenky')"
            );
        }

        await this.waitTurn();
        const meta = await this.get<DmCategoryResponse>(`${this.contentBase}/${opts.category}/`, {
            signal: opts.signal,
        });
        const productQuery = extractProductQuery(meta);
        if (!productQuery) {
            return;
        }

        let yielded = 0;
        let page = 0;
        let totalPages = 1;
        while (page < totalPages) {
            opts.signal?.throwIfAborted();
            await this.waitTurn();
            const listing = await this.get<DmProductListingResponse>(this.searchBase, {
                params: {
                    ...productQuery,
                    pageSize: PAGE_SIZE,
                    currentPage: page,
                    sort: "price_asc",
                    type: "search-static",
                },
                signal: opts.signal,
            });

            for (const product of listing.products ?? []) {
                yield this.toRawProduct(product, opts.category);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            totalPages = listing.totalPages ?? 1;
            page++;
        }
    }

    async listCategories(): Promise<Category[]> {
        await this.waitTurn();
        const tree = await this.get<DmNavigationResponse>(`${this.contentBase}/`, {
            params: { view: "navigation" },
        });
        const out: Category[] = [];
        flattenNavigation(tree.navigation, undefined, out, this.storeRoot);
        return out;
    }

    private toRawProduct(p: DmRawProduct, categoryPath: string): RawProduct {
        const td = p.tileData ?? {};
        const titlePieces: string[] = [];
        if (p.brandName) {
            titlePieces.push(p.brandName);
        }

        if (td.title?.tileHeadline) {
            titlePieces.push(td.title.tileHeadline);
        }

        const name = titlePieces.join(" ").trim() || td.title?.tileHeadlineLong || String(p.gtin ?? p.dan ?? "");
        const slug = (td.self ?? "").replace(/^\//, "") || String(p.gtin ?? p.dan ?? "");
        const url = td.self ? new URL(td.self, this.storeRoot).href : this.storeRoot;
        const itemId = String(p.dan ?? p.gtin ?? "");
        const ean = p.gtin !== undefined ? String(p.gtin) : undefined;

        return {
            shopOrigin: this.shopOrigin,
            slug,
            itemId,
            url,
            name,
            brand: p.brandName,
            ean,
            imageUrl: td.images?.[0]?.tileSrc ?? td.images?.[0]?.src,
            categoryPath: categoryPath.split("/").filter((s) => s.length > 0),
            currentPrice: parsePrice(td.price?.price?.current?.value),
            originalPrice: parsePrice(td.price?.price?.previous?.value),
            inStock: undefined,
            observedAt: new Date(),
            raw: p,
        };
    }
}

function extractProductQuery(meta: DmCategoryResponse): Record<string, string | number> | undefined {
    for (const entry of meta.mainData ?? []) {
        const q = entry.query;
        if (q && typeof q.filters === "string" && q.filters.length > 0) {
            return {
                queryTerms: q.queryTerms ?? "",
                filters: q.filters,
            };
        }
    }

    return undefined;
}

function flattenNavigation(
    node: DmNavigationNode,
    parent: string | undefined,
    out: Category[],
    storeRoot: string
): void {
    if (node.link && node.title) {
        const id = node.link.replace(/^\//, "");
        out.push({
            id,
            name: node.title,
            parentId: parent,
            slug: id,
            url: `${storeRoot}${node.link.startsWith("/") ? "" : "/"}${node.link}`,
        });
        for (const child of node.children ?? []) {
            flattenNavigation(child, id, out, storeRoot);
        }

        return;
    }

    for (const child of node.children ?? []) {
        flattenNavigation(child, parent, out, storeRoot);
    }
}

function parsePrice(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value
        .replace(/[^\d,.\s ]/g, "")
        .replace(/[\s ]+/g, "")
        .replace(/,/g, ".");
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : undefined;
}
