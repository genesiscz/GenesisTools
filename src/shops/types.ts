import type { ShopOrigin } from "@app/shops/api/ShopApiClient.types";

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

export interface MasterListItem {
    id: number;
    canonical_name: string;
    canonical_slug: string;
    brand: string | null;
    representative_image_url: string | null;
    total_offers: number;
    best_price: number | null;
    best_price_shop: ShopOrigin | null;
    master_category_id: number | null;
}

export interface MasterListResponse {
    items: MasterListItem[];
    total: number;
    limit: number;
    offset: number;
}

export interface MasterOfferRow {
    product_id: number;
    shop_origin: ShopOrigin;
    shop_display_name: string;
    name: string;
    url: string;
    image_url: string | null;
    current_price: number | null;
    original_price: number | null;
    in_stock: 0 | 1 | null;
    price_observed_at: string | null;
    claimed_discount_percent: number | null;
    real_discount_percent: number | null;
    brand: string | null;
    ean: string | null;
    unit: string | null;
    unit_amount: number | null;
    pack_count: number | null;
    description: string | null;
    category_path: string | null;
    metadata_json: string | null;
    first_seen_at: string | null;
    last_updated_at: string | null;
}

export interface MasterDetail {
    id: number;
    canonical_name: string;
    canonical_slug: string;
    brand: string | null;
    brand_normalized: string | null;
    ean: string | null;
    representative_image_url: string | null;
    total_offers: number;
    best_price: number | null;
    best_price_shop: ShopOrigin | null;
    best_price_at: string | null;
    master_category_id: number | null;
    master_category_name: string | null;
    unit: string | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
    attributes_json: Record<string, unknown>;
    offers: MasterOfferRow[];
}

export interface PriceHistoryPoint {
    date: string;
    [shop_origin: string]: number | null | string;
}

export interface PriceHistoryResponse {
    shops: ShopOrigin[];
    points: PriceHistoryPoint[];
    range: { from: string; to: string };
}

export type LiveEventName = "http-request" | "crawl-progress" | "notification-fired";

export interface LiveHttpRequestEvent {
    event: "http-request";
    id: number;
    ts: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    url: string;
    shop_origin: ShopOrigin | null;
    source: string;
    operation: string | null;
    status: number | null;
    duration_ms: number;
    request_id: string | null;
    crawl_run_id: number | null;
    product_slug: string | null;
    master_product_id: number | null;
    category_id: string | null;
    error: string | null;
    request_excerpt?: string | null;
    response_excerpt?: string | null;
}

export interface LiveCrawlProgressEvent {
    event: "crawl-progress";
    crawl_run_id: number;
    shop_origin: ShopOrigin;
    strategy: string;
    products_seen: number;
    products_new: number;
    prices_recorded: number;
    status: "running" | "matching" | "completed" | "failed" | "cancelled";
    ts: string;
}

export interface LiveNotificationFiredEvent {
    event: "notification-fired";
    notification_id: number;
    favorite_id: number;
    master_product_id: number;
    shop_origin: ShopOrigin | null;
    title: string;
    body: string;
    detail_url: string;
    buy_url: string | null;
    ts: string;
}

export type LiveEvent = LiveHttpRequestEvent | LiveCrawlProgressEvent | LiveNotificationFiredEvent;

export interface CoverageRow {
    shop_origin: ShopOrigin;
    display_name: string;
    enabled: 0 | 1;
    cap_live: 0 | 1;
    cap_history: 0 | 1;
    cap_listing: 0 | 1;
    cap_ean: 0 | 1;
    cap_search: 0 | 1;
    bot_protection: "none" | "soft" | "akamai" | "cloudflare";
    product_count: number;
    last_crawl_at: string | null;
    recent_runs: Array<{
        id: number;
        started_at: string;
        finished_at: string | null;
        status: "running" | "matching" | "completed" | "failed" | "cancelled";
        products_seen: number;
        products_new: number;
    }>;
    hlidac_dashboard?: {
        productCount?: number;
        lastUpdate?: string;
        [key: string]: unknown;
    };
}

export interface CoverageResponse {
    rows: CoverageRow[];
    summary: {
        total_products: number;
        total_offers_today: number;
        last_crawl_at: string | null;
    };
}

export type DefaultLandingView = "/watchlist" | "/" | "/browse" | "/live" | "/workspace";
export type ThemeChoice = "cyberpunk" | "wow";

export interface NotificationChannelsConfig {
    macos: boolean;
    web_sse: boolean;
    telegram: boolean;
    telegram_bot_token: string | null;
    telegram_chat_id: string | null;
}

export interface ShopConfig {
    rate_limit_per_second: number | null;
    enabled: boolean;
}

export interface SettingsPayload {
    default_landing_view: DefaultLandingView;
    theme: ThemeChoice;
    notification_channels: NotificationChannelsConfig;
    default_cooldown_hours: number;
    http_requests_retention_days: number;
    default_rate_limit_per_second: number;
    shops: Record<string, ShopConfig>;
    daemon_enabled: boolean;
}

export interface CompareResponse {
    items: MasterDetail[];
    requested_ids: number[];
}

export interface SearchHit {
    type: "master" | "product";
    id: number;
    name: string;
    brand: string | null;
    image_url: string | null;
    shop_origin?: ShopOrigin | null;
    slug?: string | null;
    rank: number;
    best_price: number | null;
    /** Master-only: number of distinct shops carrying this master. Null for product hits. */
    total_offers: number | null;
    /** Master-only: shop with the current best price. */
    best_price_shop: ShopOrigin | null;
}

export interface SearchResponse {
    hits: SearchHit[];
    query: string;
    limit: number;
}
