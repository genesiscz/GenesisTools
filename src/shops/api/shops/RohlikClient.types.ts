// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/rohlik-daily/main.js

export interface RohlikRawCategory {
    id: number;
    name: string;
    parentId: number;
    children: number[];
    link?: string;
    companyId?: number;
}

export interface RohlikFlatNavigationResponse {
    navigation: Record<string, RohlikRawCategory>;
}

export interface RohlikCategoryCountResponse {
    results: number;
}

export interface RohlikCategoryProductsResponse {
    productIds: number[];
    canonicalCategoryId?: number;
}

export interface RohlikRawSale {
    type: string;
    silent?: boolean;
    price?: { amount: number; currency?: string };
    pricePerUnit?: { amount: number };
    priceForUnit?: { amount: number };
}

export interface RohlikRawProduct {
    id?: number;
    productId?: number;
    name: string;
    slug: string;
    images?: string[];
    brand?: string;
    unit?: string;
    textualAmount?: string;
    mainCategoryId?: number;
    ean?: string;
    inStock?: boolean;
}

export type RohlikProductsBatchResponse = RohlikRawProduct[] | { data?: RohlikRawProduct[] };

export interface RohlikProductPriceEntry {
    productId: number;
    price?: { amount: number; currency?: string };
    pricePerUnit?: { amount: number; currency?: string };
    sales?: RohlikRawSale[];
}

export type RohlikProductsPricesBatchResponse = RohlikProductPriceEntry[];
