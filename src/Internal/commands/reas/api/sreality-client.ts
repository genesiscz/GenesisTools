import type {
    SrealityCluster,
    SrealityGeometry,
    SrealityGeometryQuery,
    SrealityHistogramBucket,
    SrealityV1QueryParams,
    SuggestResult,
} from "@app/Internal/commands/reas/api/SrealityClient";
import { parseSrealityName, SrealityClient } from "@app/Internal/commands/reas/api/SrealityClient";
import type { AnalysisFilters, SaleListing, SrealityRental } from "@app/Internal/commands/reas/types";

export { parseSrealityName, SrealityClient };
export type {
    SrealityCluster,
    SrealityGeometry,
    SrealityGeometryQuery,
    SrealityHistogramBucket,
    SrealityV1QueryParams,
    SuggestResult,
};

export const srealityClient = new SrealityClient();

export async function fetchRentalListings(filters: AnalysisFilters, refresh = false): Promise<SrealityRental[]> {
    return srealityClient.fetchRentalListings(filters, refresh);
}

export async function fetchSaleListings(filters: AnalysisFilters, refresh = false): Promise<SaleListing[]> {
    return srealityClient.fetchSaleListings(filters, refresh);
}

export async function suggestLocality(phrase: string): Promise<SuggestResult[]> {
    return srealityClient.suggestLocality(phrase);
}

export async function fetchHistogram(params: SrealityV1QueryParams): Promise<SrealityHistogramBucket[]> {
    return srealityClient.fetchHistogram(params);
}

export async function fetchClusters(params: SrealityV1QueryParams): Promise<SrealityCluster[]> {
    return srealityClient.fetchClusters(params);
}

export async function fetchGeometries(query: SrealityGeometryQuery): Promise<SrealityGeometry[]> {
    return srealityClient.fetchGeometries(query);
}
