import type { ApiClientConfig } from "@app/utils/api/ApiClient";

export type ShopOrigin = string;

export interface ShopCapabilities {
    live: boolean;
    history: boolean;
    listing: boolean;
    ean: boolean;
    search: boolean;
    botProtection: "none" | "soft" | "akamai" | "cloudflare";
}

export interface RawProduct {
    shopOrigin: ShopOrigin;
    slug: string;
    itemId?: string;
    url: string;
    name: string;
    brand?: string;
    ean?: string;
    imageUrl?: string;
    categoryPath?: string[];
    unit?: string;
    unitAmount?: number;
    currentPrice?: number;
    originalPrice?: number;
    inStock?: boolean;
    description?: string;
    observedAt: Date;
    raw: unknown;
}

export interface Category {
    id: string;
    name: string;
    slug?: string;
    parentId?: string;
    url?: string;
}

export interface ListingOptions {
    category?: string;
    page?: number;
    limit?: number;
    signal?: AbortSignal;
}

export interface SearchOptions {
    query: string;
    category?: string;
    limit?: number;
    signal?: AbortSignal;
}

export interface ShopApiClientInterface {
    readonly shopOrigin: ShopOrigin;
    readonly displayName: string;
    readonly currency: string;
    readonly capabilities: ShopCapabilities;

    getProduct(input: { url?: string; slug?: string; signal?: AbortSignal }): Promise<RawProduct>;
    listCategory(opts: ListingOptions): AsyncIterable<RawProduct>;
    listCategories(): Promise<Category[]>;
    search?(opts: SearchOptions): Promise<RawProduct[]>;

    parseUrl(url: string): { shopOrigin: ShopOrigin; slug: string; itemId?: string };
}

export interface ShopApiClientConfig extends ApiClientConfig {
    rateLimitPerSecond?: number;
}
