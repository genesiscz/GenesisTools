import type { Generated, Insertable, Selectable, Updateable } from "kysely";

export interface ShopsTable {
    origin: string;
    display_name: string;
    currency: string;
    cap_live: number;
    cap_history: number;
    cap_listing: number;
    cap_ean: number;
    cap_search: number;
    bot_protection: "none" | "soft" | "akamai" | "cloudflare";
    enabled: Generated<number>;
    last_crawl_at: string | null;
    homepage_url: string | null;
    notes: string | null;
}

export interface MasterCategoriesTable {
    id: Generated<number>;
    name: string;
    slug: string;
    parent_id: number | null;
    metadata_json: Generated<string>;
}

export interface CategoriesTable {
    id: string;
    shop_origin: string;
    name: string;
    parent_id: string | null;
    slug: string | null;
    url: string | null;
    product_count: number | null;
    master_category_id: number | null;
    metadata_json: Generated<string>;
}

export interface MasterProductsTable {
    id: Generated<number>;
    canonical_name: string;
    canonical_name_normalized: string;
    canonical_slug: string;
    brand: string | null;
    brand_normalized: string | null;
    ean: string | null;
    master_category_id: number | null;
    unit: "g" | "kg" | "ml" | "l" | "ks" | "m" | "m2" | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
    representative_image_url: string | null;
    total_offers: Generated<number>;
    best_price: number | null;
    best_price_shop: string | null;
    best_price_at: string | null;
    attributes_json: Generated<string>;
    created_at: Generated<string>;
    updated_at: Generated<string>;
    verified_by: "auto" | "user" | null;
    description: string | null;
}

export interface ProductsTable {
    id: Generated<number>;
    shop_origin: string;
    slug: string;
    url: string;
    name: string;
    name_normalized: string;
    brand: string | null;
    brand_normalized: string | null;
    ean: string | null;
    image_url: string | null;
    unit: "g" | "kg" | "ml" | "l" | "ks" | "m" | "m2" | null;
    unit_amount: number | null;
    pack_count: number | null;
    flavor_key: string | null;
    master_product_id: number | null;
    match_method:
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
    match_similarity: number | null;
    match_at: string | null;
    first_seen_at: string;
    last_updated_at: string;
    is_active: Generated<number>;
    metadata_json: Generated<string>;
    description: string | null;
    category_path: string | null;
}

export interface ProductCategoriesTable {
    product_id: number;
    category_id: string;
    shop_origin: string;
}

export interface MatchCandidatesTable {
    product_id_a: number;
    product_id_b: number;
    similarity: number;
    match_method: "fuzzy" | "sig:no-flavor" | "sig:no-size" | "fuzzy-brand-name" | "image-phash" | "llm:haiku";
    status: Generated<"pending" | "accepted" | "rejected">;
    reviewed_at: string | null;
    reviewed_by: "user" | "auto" | "llm:haiku" | null;
    notes: string | null;
    created_at: string;
}

export interface PricesTable {
    product_id: number;
    observed_at: string;
    current_price: number | null;
    original_price: number | null;
    in_stock: number | null;
    source: string;
    raw_json: string | null;
}

export interface CrawlRunsTable {
    id: Generated<number>;
    shop_origin: string;
    strategy: string;
    started_at: string;
    finished_at: string | null;
    products_seen: Generated<number>;
    products_new: Generated<number>;
    prices_recorded: Generated<number>;
    candidates_added: Generated<number>;
    status: Generated<"running" | "matching" | "completed" | "failed" | "cancelled">;
    error: string | null;
    option_category_id: string | null;
    option_limit: number | null;
    option_since: string | null;
    options_json: Generated<string>;
}

export interface FavoritesTable {
    id: Generated<number>;
    master_product_id: number;
    restricted_to_shop: string | null;
    label: string | null;
    target_price: number | null;
    drop_percent: number | null;
    drop_absolute: number | null;
    reference_price: number | null;
    notify_back_in_stock: Generated<number>;
    cooldown_hours: Generated<number>;
    active: Generated<number>;
    created_at: string;
}

export interface NotificationsTable {
    id: Generated<number>;
    favorite_id: number;
    master_product_id: number;
    product_id: number | null;
    fired_at: string;
    reason: "target-price" | "drop-percent" | "drop-absolute" | "back-in-stock";
    prev_price: number | null;
    curr_price: number | null;
    shop_origin: string | null;
    delivered_macos_at: string | null;
    delivered_web_at: string | null;
    delivered_telegram_at: string | null;
    delivery_error: string | null;
    acknowledged_at: string | null;
    metadata_json: Generated<string>;
}

export interface HttpRequestsTable {
    id: Generated<number>;
    ts: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    url: string;
    shop_origin: string | null;
    source: string;
    operation: string | null;
    status: number | null;
    duration_ms: number;
    request_bytes: number | null;
    response_bytes: number | null;
    request_id: string | null;
    crawl_run_id: number | null;
    product_slug: string | null;
    master_product_id: number | null;
    category_id: string | null;
    error: string | null;
    request_excerpt: string | null;
    response_excerpt: string | null;
    context_json: Generated<string>;
}

export interface BrandAliasesTable {
    alias: string;
    canonical: string;
    source: "seed" | "user" | "auto";
    created_at: string;
}

// FTS5 virtual table mirrors a subset of products columns. Queried via raw SQL
// (Kysely doesn't model MATCH); kept here so SearchRepository / searchProducts
// can replace inline interfaces with a single source of truth.
// Intentionally NOT added to ShopsDB — FTS5 has no rowid-typed Kysely access.
export interface ProductsFtsTable {
    rowid: number;
    name: string;
    name_normalized: string;
    brand: string | null;
    brand_normalized: string | null;
    category_path: string | null;
    rank: number; // FTS5 pseudo-column exposed in SELECT but not stored
}

export interface CurrentOffersView {
    product_id: number;
    shop_origin: string;
    master_product_id: number | null;
    name: string;
    url: string;
    image_url: string | null;
    current_price: number | null;
    original_price: number | null;
    in_stock: number | null;
    price_observed_at: string;
}

export interface ShopsDB {
    shops: ShopsTable;
    master_categories: MasterCategoriesTable;
    categories: CategoriesTable;
    products: ProductsTable;
    product_categories: ProductCategoriesTable;
    master_products: MasterProductsTable;
    match_candidates: MatchCandidatesTable;
    prices: PricesTable;
    crawl_runs: CrawlRunsTable;
    favorites: FavoritesTable;
    notifications: NotificationsTable;
    http_requests: HttpRequestsTable;
    brand_aliases: BrandAliasesTable;
    current_offers: CurrentOffersView;
}

export type Product = Selectable<ProductsTable>;
export type NewProduct = Insertable<ProductsTable>;
export type ProductUpdate = Updateable<ProductsTable>;

export type MasterProduct = Selectable<MasterProductsTable>;
export type NewMasterProduct = Insertable<MasterProductsTable>;

export type Price = Selectable<PricesTable>;
export type NewPrice = Insertable<PricesTable>;

export type HttpRequest = Selectable<HttpRequestsTable>;
export type NewHttpRequest = Insertable<HttpRequestsTable>;
