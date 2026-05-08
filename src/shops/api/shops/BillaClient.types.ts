// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/billa/main.js

export interface BillaPriceField {
    /** Price in halves of cents (per actor's `toCZK = v / 100`). */
    value: number;
    perStandardizedQuantity?: number;
}

export interface BillaProductPrice {
    regular?: BillaPriceField;
    discounted?: BillaPriceField;
}

export interface BillaParentCategory {
    name: string;
}

export interface BillaRawProduct {
    sku: string;
    name: string;
    slug: string;
    parentCategories?: BillaParentCategory[];
    images?: string[];
    price?: BillaProductPrice;
    baseUnitShort?: string;
    weightPieceArticle?: string | null;
}

export interface BillaCategoryListingResponse {
    total?: number;
    count?: number;
    page?: number;
    products?: BillaRawProduct[];
}
