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

export interface HlidacGetByUrlResult {
    source: "s3" | "api" | "scrape";
    parsed: { origin: string; itemId: string | null; itemUrl: string };
    history: HsPriceHistoryS3 | null;
    detail?: HsDetailResponse;
    meta?: HsMetaS3;
}
