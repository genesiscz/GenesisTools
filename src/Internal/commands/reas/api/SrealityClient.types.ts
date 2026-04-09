import type { AnalysisFilters, CacheEntry, SaleListing, SrealityRental } from "@app/Internal/commands/reas/types";
import type { ApiClient } from "@app/utils/api/ApiClient";
import { SOURCE_CONTRACTS } from "./source-contracts";

export const SREALITY_V2_SOURCE_CONTRACT = SOURCE_CONTRACTS.SREALITY_V2;
export const SREALITY_V1_HISTOGRAM_SOURCE_CONTRACT = SOURCE_CONTRACTS.SREALITY_V1_HISTOGRAM;
export const SREALITY_V1_CLUSTERS_SOURCE_CONTRACT = SOURCE_CONTRACTS.SREALITY_V1_CLUSTERS;
export const SREALITY_V1_GEOMETRIES_SOURCE_CONTRACT = SOURCE_CONTRACTS.SREALITY_V1_GEOMETRIES;

export type SrealityOfferType = "rental" | "sale";

export type SrealityApiClientLike = Pick<ApiClient, "get">;

export interface SrealityCacheAdapter {
    getCached<T>(key: string, ttlMs: number): Promise<CacheEntry<T> | null>;
    setCache<T>(key: string, entry: CacheEntry<T>): Promise<void>;
}

export interface SrealityClientConfig {
    apiV1?: SrealityApiClientLike;
    apiV2?: SrealityApiClientLike;
    cache?: SrealityCacheAdapter;
}

export interface SrealityEstateRaw {
    hash_id: number;
    name: string;
    price: number;
    locality: string;
    gps: { lat: number; lon: number };
    labels: string[];
    seo?: {
        category_main_cb: number;
        category_sub_cb: number;
        category_type_cb: number;
        locality: string;
    };
}

export interface SrealityListResponse {
    _embedded?: { estates?: SrealityEstateRaw[] };
    result_size: number;
    per_page: number;
    page: number;
}

export interface SrealitySuggestItem {
    category: string;
    userData: {
        suggestFirstRow: string;
        entityType: string;
        municipality_id: number;
        district_id: number;
        region_id: number;
        municipality: string;
        district: string;
        region: string;
    };
}

export interface SrealitySuggestResponse {
    count: number;
    data?: SrealitySuggestItem[];
}

export interface SuggestResult {
    value: string;
    regionType: string;
    regionId: number;
    districtId: number;
    municipality: string;
}

export interface ParseSrealityNameResult {
    disposition?: string;
    area?: number;
}

export interface SrealityHistogramBucket {
    advert_count: number;
    price_from: number;
    price_to: number;
}

export interface SrealityHistogramResponse {
    result?: {
        histogram?: SrealityHistogramBucket[];
    };
    status_code?: number;
    status_message?: string;
}

export interface SrealityCluster {
    lat?: number;
    lon?: number;
    lng?: number;
    count?: number;
    [key: string]: unknown;
}

export interface SrealityClustersResponse {
    results?: SrealityCluster[];
    status_code?: number;
    status_message?: string;
}

export interface SrealityGeometry {
    entity_id: number;
    entity_type: string;
    geometry: string[];
    geometry_type?: string;
    bounding_box?: {
        lat_max: number;
        lat_min: number;
        lon_max: number;
        lon_min: number;
    };
    children?: SrealityGeometry[];
}

export interface SrealityGeometriesResponse {
    result?: SrealityGeometry[];
    status_code?: number;
    status_message?: string;
}

export interface SrealityGeometryQuery {
    entityId: number;
    entityType: string;
    noChildren?: boolean;
}

export interface SrealityV1QueryParams {
    [key: string]: string | number | boolean | null | undefined;
}

export interface SrealitySearchResult<TListing> {
    listings: TListing[];
    sourceContract: string;
}

export interface SrealityListingRequest {
    filters: AnalysisFilters;
    offerType: SrealityOfferType;
    refresh: boolean;
}

export interface SrealityListingMapper<TListing> {
    sourceContract: string;
    mapEstate(raw: SrealityEstateRaw): TListing;
}

export type SrealityRentalSearchResult = SrealitySearchResult<SrealityRental>;
export type SrealitySaleSearchResult = SrealitySearchResult<SaleListing>;
