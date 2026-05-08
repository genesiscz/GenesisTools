// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/mall-daily/main.js

export interface MallProductMainVariant {
    id: string;
    title?: string;
    price: number;
    isAvailable: boolean;
    hasSale?: boolean;
    inPromotion?: boolean;
    originalSalePrice?: number;
    discountPromotionSalePrice?: number;
    rrpSavePercent?: number;
    discountPrice?: number;
    discountPromotionPrice?: number;
    defaultActualPrice?: number;
    promotionPrice?: number;
    promotionEnd?: string;
    priceType?: string;
    priceRrp?: number;
    mediaIds?: string[];
    mainMenuPath?: string[];
    pricePerUnit?: { value?: number; measure?: string } | null;
}

export interface MallProduct {
    id: string;
    title?: string;
    mainCategoryUrlKey: string;
    urlKey: string;
    mainVariant: MallProductMainVariant;
}

export interface MallCampaignResponse {
    data?: {
        getCampaign?: {
            productCollection?: {
                itemsTotalCount?: number;
                items?: MallProduct[];
            };
        };
    };
    errors?: Array<{ message: string }>;
}

export interface MallGetCampaignVariables {
    allFilters: boolean;
    productSorting: string | null;
    isMobile: boolean;
    bannersPage: string;
    includeBonusSets: boolean;
    campaignId: string;
    filters: unknown[];
    pagination: { limit: number; offset: number };
    categoryUrlKey?: string;
}

export interface MallCountryConfig {
    tld: "cz" | "sk";
    currency: "CZK" | "EUR";
}
