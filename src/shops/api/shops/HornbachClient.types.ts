// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/hornbach-daily/main.js

export const HORNBACH_SELECTORS = {
    /** Top-level category cards on homepage. */
    TOP_CATEGORIES: '[data-testid="hbhd-mainnav-categories"] a',
} as const;

export interface HornbachApolloPriceWithUnit {
    __typename?: string;
    price?: number;
    currency?: string;
    currencyCode?: string;
    unit?: string;
    prefix?: string | null;
}

export interface HornbachApolloImage {
    __typename?: string;
    url?: string;
    thumbnailUrl?: string;
    title?: string;
    alt?: string;
}

export interface HornbachApolloProduct {
    __typename?: string;
    abstractProductId?: string;
    title?: string;
    url?: string;
    mainImage?: HornbachApolloImage;
    defaultPrice?: HornbachApolloPriceWithUnit;
    basicPrice?: HornbachApolloPriceWithUnit;
}

export interface HornbachApolloCategoryListing {
    __typename?: string;
    itemList?: HornbachApolloProduct[];
    category?: {
        __typename?: string;
        productCategoryId?: string;
        name?: string;
        url?: string;
    };
}

export interface HornbachApolloRootQuery {
    [key: string]: HornbachApolloCategoryListing | unknown;
}

export interface HornbachApolloState {
    ROOT_QUERY?: HornbachApolloRootQuery;
}
