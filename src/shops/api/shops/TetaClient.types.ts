// Adapted from topmonks/hlidac-shopu (EUPL-1.2) — actors/tetadrogerie-daily/main.js

export interface TetaTaxon {
    id: number;
    name: string;
    parentId: number | null;
}

export interface TetaBbyPrices {
    /** Discounted price in halves (divide by 100 for CZK). */
    acmd?: number;
    /** Original price in halves. */
    zcmd?: number;
    /** Multi-item discount conditions string (e.g. "2 ks za 350 Kč při koupi 2 ks"). */
    conditions?: string | null;
}

export interface TetaRawProduct {
    code: string;
    name: string;
    slug: string;
    image?: string;
    price?: number;
    currentPrice?: number;
    originalPrice?: number;
    bbyPrices?: TetaBbyPrices;
    isStockAvailable?: boolean;
    taxa?: TetaTaxon[];
}

export interface TetaPagination {
    currentPage?: number;
    lastPage?: number;
    totalItems?: number;
}

export interface TetaCategoryListingResponse {
    pagination?: TetaPagination;
    products?: TetaRawProduct[];
}
