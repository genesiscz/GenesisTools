// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/notino-daily/main.js

export interface NotinoMainMenuState {
    fragmentContextData: {
        DataProvider: {
            categories: NotinoMenuCategory[];
        };
    };
}

export interface NotinoMenuCategory {
    link?: string;
    columns: Array<{
        subCategories: Array<{
            isLink?: boolean;
            link?: string;
            productTypes: Array<{ link: string; name?: string }>;
        }>;
    }>;
}

export interface NotinoCatalogVariant {
    webId: string;
    url: string;
    name?: string;
    variantName?: string;
    additionalInfo?: string;
    availability?: { state?: string };
    price: { value: number; currency?: string };
    originalPrice?: { value: number };
    recentMinPrice?: { value: number };
    attributes?: {
        VoucherDiscount?: { discountedPrice?: number };
        ConditionalVoucherDiscount?: {
            discountConditions?: Array<{ productMeetsCondition?: boolean; discountedPrice?: number }>;
        };
    };
}

export type NotinoApolloCache = Record<string, unknown>;

export interface NotinoPricePair {
    currentPrice: number;
    originalPrice?: number;
}
