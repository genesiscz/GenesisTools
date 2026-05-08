import type { ShopOrigin } from "./api/ShopApiClient.types";

export type MatchMethod =
    | "ean"
    | "fuzzy"
    | "sig:no-flavor"
    | "sig:no-size"
    | "fuzzy-brand-name"
    | "auto-seed"
    | "gray-zone"
    | "pending"
    | "user"
    | "llm:haiku";

export interface Product {
    id: number;
    shopOrigin: ShopOrigin;
    slug: string;
    url: string;
    name: string;
    nameNormalized: string;
    brand: string | null;
    brandNormalized: string | null;
    ean: string | null;
    imageUrl: string | null;
    unit: string | null;
    unitAmount: number | null;
    packCount: number | null;
    flavorKey: string | null;
    masterProductId: number | null;
    matchMethod: MatchMethod;
    matchSimilarity: number | null;
    isActive: boolean;
    firstSeenAt: string;
    lastUpdatedAt: string;
}

export interface PriceObservation {
    productId: number;
    observedAt: string;
    currentPrice: number | null;
    originalPrice: number | null;
    inStock: boolean | null;
    source: string;
}

export interface CurrentOffer {
    productId: number;
    shopOrigin: ShopOrigin;
    masterProductId: number | null;
    name: string;
    url: string;
    imageUrl: string | null;
    currentPrice: number | null;
    originalPrice: number | null;
    inStock: boolean | null;
    priceObservedAt: string;
}

export interface ProductIngestResult {
    product: Product;
    masterProductId: number | null;
    pricesRecorded: number;
    source: "s3" | "api" | "scrape" | "cache";
}
