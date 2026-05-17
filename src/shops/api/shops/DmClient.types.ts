// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/dm-daily/main.js

export interface DmNavigationNode {
    id?: string;
    title: string;
    link?: string;
    hidden?: boolean;
    children?: DmNavigationNode[];
}

export interface DmNavigationResponse {
    type?: string;
    navigation: DmNavigationNode;
}

export interface DmCategoryQuery {
    queryTerms?: string;
    sort?: string;
    filters?: string;
    numberOfProducts?: { desktop?: number; mobile?: number };
}

export interface DmCategoryMainDataEntry {
    type?: string;
    module?: string;
    query?: DmCategoryQuery;
}

export interface DmCategoryResponse {
    mainData?: DmCategoryMainDataEntry[];
}

export interface DmTileImage {
    tileSrc?: string;
    src?: string;
}

export interface DmTilePriceCurrent {
    value?: string;
}

export interface DmTilePriceField {
    current?: DmTilePriceCurrent;
    previous?: DmTilePriceCurrent;
}

export interface DmTilePrice {
    prefix?: string;
    price?: DmTilePriceField;
    tileInfos?: string[];
}

export interface DmTileData {
    title?: { preheadline?: string; tileHeadline?: string; tileHeadlineLong?: string };
    self?: string;
    images?: DmTileImage[];
    price?: DmTilePrice;
    trackingData?: { currency?: string; brand?: string };
}

export interface DmRawProduct {
    gtin?: number | string;
    dan?: number | string;
    brandName?: string;
    title?: string;
    tileData?: DmTileData;
}

export interface DmProductListingResponse {
    products?: DmRawProduct[];
    currentPage?: number;
    totalPages?: number;
    total?: number;
}
