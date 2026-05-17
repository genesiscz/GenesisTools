export interface HsS3Entry {
    d: string;
    c: number | null;
    o: number | null;
}

export interface HsPriceHistoryS3 {
    commonPrice: number | null;
    minPrice: number | null;
    entries: HsS3Entry[];
}

export interface HsMetaS3 {
    itemId: string;
    itemName: string;
    itemImage?: string;
    [k: string]: unknown;
}

export interface HsDetailResponse {
    data: {
        originalPrice: { x: string; y: number | null }[];
        currentPrice: { x: string; y: number | null }[];
    };
    metadata: {
        shop?: string;
        name?: string;
        imageUrl?: string;
        realDiscount?: number;
        claimedDiscount?: number;
        type?: string;
        [k: string]: unknown;
    };
}

/** Optional enrichment from the per-shop ShopClient, merged when Hlídač's data lacks brand/EAN/etc. */
export interface HlidacEnrichment {
    brand?: string;
    ean?: string;
    unit?: "g" | "kg" | "ml" | "l" | "ks" | "m" | "m2";
    unitAmount?: number;
    packCount?: number;
    categoryPath?: string[];
}

interface HlidacGetByUrlBase {
    parsed: { origin: string; itemId: string | null; itemUrl: string };
    /** Populated when get-product.ts merged a ShopClient.getProduct result for richer metadata. */
    enrichment?: HlidacEnrichment;
}

/** S3 path: hit Hlídač's bucket directly. Carries history + optional meta. */
export interface HlidacGetByUrlS3Result extends HlidacGetByUrlBase {
    source: "s3";
    history: HsPriceHistoryS3;
    meta?: HsMetaS3;
    detail?: undefined;
}

/** API path: fell back to /v2/detail. No history; detail may be undefined if API also failed. */
export interface HlidacGetByUrlApiResult extends HlidacGetByUrlBase {
    source: "api";
    history: null;
    detail?: HsDetailResponse;
    /** Synthesized by get-product enrichment when a ShopClient call backfilled the canonical name. */
    meta?: HsMetaS3;
}

/** Scrape path: synthesized from a ShopClient response when Hlídač had no usable name. */
export interface HlidacGetByUrlScrapeResult extends HlidacGetByUrlBase {
    source: "scrape";
    history: HsPriceHistoryS3 | null;
    detail?: HsDetailResponse;
    meta?: HsMetaS3;
}

export type HlidacGetByUrlResult = HlidacGetByUrlS3Result | HlidacGetByUrlApiResult | HlidacGetByUrlScrapeResult;
