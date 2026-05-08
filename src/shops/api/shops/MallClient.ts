// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/mall-daily/main.js

import { ShopApiClient, type ShopApiClientConstructorConfig } from "../ShopApiClient";
import type { Category, ListingOptions, RawProduct, ShopCapabilities } from "../ShopApiClient.types";
import type {
    MallCampaignResponse,
    MallCountryConfig,
    MallGetCampaignVariables,
    MallProduct,
    MallProductMainVariant,
} from "./MallClient.types";

const PAGE_LIMIT = 80;
const COUNTRY_CZ: MallCountryConfig = { tld: "cz", currency: "CZK" };

const GET_CAMPAIGN_QUERY = `
query getCampaningForList(
    $campaignId: String!,
    $categoryUrlKey: String,
    $pagination: ProductCollectionPaginationInput,
    $allFilters: Boolean = false,
    $filters: [ProductFilterValueInput!],
    $productSorting: String = null,
    $previewHash: String = "",
    $abTestVariant: String = "",
    $isMobile: Boolean = false,
    $bannersPage: String = "",
    $includeBonusSets: Boolean = false
) {
    getCampaign(
        campaignId: $campaignId,
        query: { previewHash: $previewHash, abTestVariant: $abTestVariant, bannersPage: $bannersPage, isMobile: $isMobile }
    ) {
        id name showProductCounter showActionPrice validTo validFrom
        productCollection(
            query: { categoryUrlKey: $categoryUrlKey, pagination: $pagination, filters: $filters, allFilters: $allFilters, productSorting: $productSorting, includeBonusSets: $includeBonusSets }
        ) {
            itemsTotalCount
            items {
                ... on Product {
                    id title
                    mainVariant {
                        id price title hasSale isAvailable inPromotion originalSalePrice discountPromotionSalePrice rrpSavePercent discountPrice discountPromotionPrice defaultActualPrice promotionPrice promotionEnd
                        pricePerUnit { value measure }
                        priceType priceRrp mediaIds mainMenuPath
                    }
                    mainCategoryUrlKey urlKey
                }
            }
        }
    }
}
`.trim();

export interface MallClientConfig extends ShopApiClientConstructorConfig {
    country?: MallCountryConfig;
}

export class MallClient extends ShopApiClient {
    readonly shopOrigin: "mall.cz" | "mall.sk";
    readonly displayName = "Mall.cz";
    readonly currency: "CZK" | "EUR";
    readonly capabilities: ShopCapabilities = {
        live: true,
        history: true,
        listing: true,
        ean: false,
        search: false,
        botProtection: "none",
    };

    private readonly tld: "cz" | "sk";

    constructor(config: MallClientConfig = {}) {
        const country = config.country ?? COUNTRY_CZ;
        super({
            baseUrl: `https://www.mall.${country.tld}`,
            loggerContext: { provider: `mall-${country.tld}` },
            rateLimitPerSecond: config.rateLimitPerSecond ?? 2,
            ...config,
        });
        this.tld = country.tld;
        this.currency = country.currency;
        this.shopOrigin = `mall.${country.tld}`;
    }

    async getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct> {
        if (!input.url) {
            throw new Error("MallClient.getProduct requires opts.url");
        }

        const u = new URL(input.url);
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length < 2) {
            throw new Error(`MallClient: cannot parse URL ${input.url}`);
        }

        const urlKey = parts[parts.length - 1];
        const categoryUrlKey = parts.slice(0, -1).join("/");

        const variables: MallGetCampaignVariables = {
            allFilters: false,
            productSorting: null,
            isMobile: true,
            bannersPage: "",
            includeBonusSets: false,
            campaignId: "black-friday",
            filters: [],
            pagination: { limit: 1, offset: 0 },
            categoryUrlKey,
        };

        await this.waitTurn();
        const resp = await this.post<MallCampaignResponse>(
            "/web-gateway/graphql",
            { query: GET_CAMPAIGN_QUERY, variables },
            { signal: input.signal }
        );

        if (resp.errors && resp.errors.length > 0) {
            throw new Error(`Mall GraphQL error: ${resp.errors[0].message}`);
        }

        const items = resp.data?.getCampaign?.productCollection?.items ?? [];
        const match = items.find((p) => p.urlKey === urlKey);
        if (!match) {
            throw new Error(`Mall product ${urlKey} not found in category ${categoryUrlKey}`);
        }

        return this.toRawProduct(match);
    }

    async *listCategory(opts: ListingOptions): AsyncIterable<RawProduct> {
        if (!opts.category) {
            throw new Error("MallClient.listCategory requires opts.category (campaign id)");
        }

        let offset = 0;
        let yielded = 0;

        while (true) {
            opts.signal?.throwIfAborted();
            const variables: MallGetCampaignVariables = {
                allFilters: false,
                productSorting: null,
                isMobile: true,
                bannersPage: `/kampan/${opts.category}`,
                includeBonusSets: false,
                campaignId: opts.category,
                filters: [],
                pagination: { limit: PAGE_LIMIT, offset },
            };

            await this.waitTurn();
            const resp = await this.post<MallCampaignResponse>(
                "/web-gateway/graphql",
                { query: GET_CAMPAIGN_QUERY, variables },
                { signal: opts.signal }
            );

            if (resp.errors && resp.errors.length > 0) {
                throw new Error(`Mall GraphQL error: ${resp.errors[0].message}`);
            }

            const items = resp.data?.getCampaign?.productCollection?.items ?? [];
            if (items.length === 0) {
                return;
            }

            for (const product of items) {
                yield this.toRawProduct(product);
                yielded++;
                if (opts.limit !== undefined && yielded >= opts.limit) {
                    return;
                }
            }

            const hasMore = items.length === PAGE_LIMIT;
            if (!hasMore) {
                return;
            }

            offset += PAGE_LIMIT;
        }
    }

    async listCategories(): Promise<Category[]> {
        return [];
    }

    private toRawProduct(p: MallProduct): RawProduct {
        const v: MallProductMainVariant = p.mainVariant;
        const url = `https://www.mall.${this.tld}/${p.mainCategoryUrlKey}/${p.urlKey}`;
        const imageUrl =
            v.mediaIds?.[0] !== undefined ? `https://www.mall.${this.tld}/i/${v.mediaIds[0]}/550/550` : undefined;

        return {
            shopOrigin: this.shopOrigin,
            slug: v.id,
            itemId: v.id,
            url,
            name: v.title ?? p.title ?? "",
            currentPrice: v.price,
            originalPrice: v.priceRrp !== undefined && v.priceRrp > v.price ? v.priceRrp : undefined,
            inStock: v.isAvailable,
            imageUrl,
            categoryPath: v.mainMenuPath,
            observedAt: new Date(),
            raw: { source: "mall-graphql", product: p },
        };
    }
}
