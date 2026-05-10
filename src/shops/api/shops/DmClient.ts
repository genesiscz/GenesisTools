// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/dm-daily/main.js

import logger from "@app/logger";
import { ShopApiClient, type ShopApiClientConstructorConfig } from "@app/shops/api/ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "@app/shops/api/ShopApiClient.types";
import type {
    DmCategoryResponse,
    DmNavigationNode,
    DmNavigationResponse,
    DmProductListingResponse,
    DmRawProduct,
} from "@app/shops/api/shops/DmClient.types";
import { ApiClientError } from "@app/utils/api/ApiClient";

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

// dm's product-search API returns HTTP 429 + `{"message":"Too many requests!..."}`
// after a short burst. Empirically the sliding window recovers in ~60s. Wait
// times escalate so a longer cooldown isn't immediately retried at the same
// pace; cap at 3 attempts before surfacing the error to the caller.
const SEARCH_429_BACKOFF_MS = [10_000, 30_000, 60_000];

const dmRetryLog = logger.child({ component: "DmClient" });

export interface DmClientConfig extends ShopApiClientConstructorConfig {
    country?: DmCountry;
    /** Backoff schedule (ms) when search-api returns 429. Test-only override. */
    searchBackoffMs?: number[];
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
    protected readonly searchBackoffMs: number[];

    constructor(config: DmClientConfig = {}) {
        const { country = "CZ", searchBackoffMs, ...rest } = config;
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
        this.searchBackoffMs = searchBackoffMs ?? SEARCH_429_BACKOFF_MS;
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
            const listing = await this.fetchSearchPage(
                {
                    ...productQuery,
                    pageSize: PAGE_SIZE,
                    currentPage: page,
                    sort: "price_asc",
                    type: "search-static",
                },
                opts.signal
            );

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

    protected async fetchSearchPage(
        params: Record<string, string | number>,
        signal: AbortSignal | undefined
    ): Promise<DmProductListingResponse> {
        // Disable ofetch's built-in retry on this call so we can pace the
        // backoff ourselves; ofetch retries 429 immediately, which fails
        // every time against dm's sliding-window limiter.
        let lastError: unknown;
        for (let attempt = 0; attempt <= this.searchBackoffMs.length; attempt++) {
            signal?.throwIfAborted();
            try {
                return await this.get<DmProductListingResponse>(this.searchBase, {
                    params,
                    signal,
                    retry: 0,
                });
            } catch (err) {
                lastError = err;
                const isRateLimited = err instanceof ApiClientError && err.status === 429;
                if (!isRateLimited || attempt === this.searchBackoffMs.length) {
                    throw err;
                }

                const waitMs = this.searchBackoffMs[attempt];
                dmRetryLog.warn(
                    {
                        shop: this.shopOrigin,
                        attempt: attempt + 1,
                        maxAttempts: this.searchBackoffMs.length + 1,
                        waitMs,
                        currentPage: params.currentPage,
                    },
                    "dm search-api 429 — backing off"
                );
                await Bun.sleep(waitMs);
            }
        }

        throw lastError;
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
