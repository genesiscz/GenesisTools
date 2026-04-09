import type { ProviderLink, RentalListing, SaleListing } from "@app/Internal/commands/reas/types";
import type { ApiClient } from "@app/utils/api/ApiClient";

export type BezrealitkyAutocompleteFeature = {
    properties?: {
        osm_type?: string | null;
        osm_id?: string | number | null;
        display_name?: string | null;
    };
};

export interface BezrealitkyAutocompleteResponse {
    type?: string;
    features?: BezrealitkyAutocompleteFeature[];
}

export interface BezrealitkyGraphqlResponse<T> {
    data?: T;
    errors?: Array<{
        message?: string;
    }>;
}

export interface BezrealitkyGpsPoint {
    lat: number;
    lng: number;
}

export interface BezrealitkyRegionNode {
    id: string;
    name: string;
    uri?: string | null;
}

export interface BezrealitkyImage {
    id: string;
    order?: number | null;
    url: string;
}

export interface BezrealitkyFormattedParameter {
    title?: string | null;
    value?: string | null;
    valueHref?: string | null;
}

export interface BezrealitkyMortgageData {
    rateLow: number | null;
    rateHigh: number | null;
    years: number | null;
    loan: number | null;
}

export interface BezrealitkyAdvertRaw {
    id: string;
    uri: string;
    offerType?: string | null;
    disposition?: string | null;
    surface?: number | null;
    price?: number | null;
    charges?: number | null;
    serviceCharges?: number | null;
    utilityCharges?: number | null;
    deposit?: number | null;
    availableFrom?: number | string | null;
    originalPrice?: number | null;
    isDiscounted?: boolean | null;
    reserved?: boolean | null;
    gps?: BezrealitkyGpsPoint | null;
    links?: ProviderLink[] | null;
    poiData?: string | null;
    nemoreport?: unknown;
    [key: string]: unknown;
}

export interface BezrealitkyAdvertListRaw {
    totalCount: number;
    list: BezrealitkyAdvertRaw[];
}

export interface BezrealitkyListAdvertsData {
    listAdverts?: BezrealitkyAdvertListRaw | null;
}

export interface BezrealitkyAdvertData {
    advert?: BezrealitkyAdvertRaw | null;
}

export interface BezrealitkyClientOptions {
    graphqlClient?: ApiClient;
    autocompleteClient?: ApiClient;
    pageSize?: number;
}

export interface BezrealitkyAdvertDetail {
    id: string;
    source: "bezrealitky";
    sourceId: string;
    sourceContract: "graphql:advert";
    type: "rental" | "sale";
    uri: string;
    link: string;
    address: string;
    disposition?: string;
    surface?: number;
    price: number;
    charges?: number;
    serviceCharges?: number;
    utilityCharges?: number;
    deposit?: number;
    availableFrom?: number | string | null;
    originalPrice?: number;
    isDiscounted?: boolean;
    imageAltText?: string;
    mortgageData?: BezrealitkyMortgageData | null;
    links: ProviderLink[];
    poiData?: Record<string, unknown> | null;
    regionTree: BezrealitkyRegionNode[];
    publicImages: BezrealitkyImage[];
    formattedAds: BezrealitkyFormattedParameter[];
    relatedAdverts: Array<RentalListing | SaleListing>;
    nemoreport?: unknown;
    coordinates?: BezrealitkyGpsPoint;
    rawData: BezrealitkyAdvertRaw;
}
