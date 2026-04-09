import { cacheKey, getCached, REAS_TTL, setCache } from "@app/Internal/commands/reas/cache/index";
import { matchesRequestedDistrict } from "@app/Internal/commands/reas/lib/district-matching";
import type { AnalysisFilters, CacheEntry, DateRange, ReasListing } from "@app/Internal/commands/reas/types";
import { ApiClient } from "@app/utils/api/ApiClient";
import { SafeJSON } from "@app/utils/json";
import type { CountResponse, ListingsResponse, PointersAndClustersResponse } from "./ReasClient.types";

const BASE_URL = "https://catalog.reas.cz/catalog";
const CLIENT_ID = "6988cb437c5b9d2963280369";
const PAGE_LIMIT = 200;
const MAX_PAGES = 1000;

export function buildReasQueryParams(filters: AnalysisFilters, dateRange: DateRange): URLSearchParams {
    const params = new URLSearchParams();

    params.set("estateTypes", SafeJSON.stringify([filters.estateType]));
    params.set("constructionType", SafeJSON.stringify([filters.constructionType]));

    const soldDateRange = {
        from: dateRange.from.toISOString(),
        to: dateRange.to.toISOString(),
    };
    params.set("soldDateRange", SafeJSON.stringify(soldDateRange));

    params.set("linkedToTransfer", "true");
    params.set("locality", SafeJSON.stringify({ districtId: filters.district.reasId }));
    params.set("clientId", CLIENT_ID);

    if (filters.heatingKind?.length) {
        params.set("heatingKind", SafeJSON.stringify(filters.heatingKind));
    }

    if (filters.bounds) {
        params.set("bounds", SafeJSON.stringify(filters.bounds));
    }

    return params;
}

function buildCacheKeyParams(filters: AnalysisFilters, dateRange: DateRange): Record<string, unknown> {
    return {
        source: "reas",
        estateType: filters.estateType,
        constructionType: filters.constructionType,
        disposition: filters.disposition ?? null,
        districtId: filters.district.reasId,
        from: dateRange.from.toISOString(),
        to: dateRange.to.toISOString(),
    };
}

function filterByDisposition(listings: ReasListing[], disposition: string | undefined): ReasListing[] {
    if (!disposition) {
        return listings;
    }

    return listings.filter((listing) => listing.disposition === disposition);
}

function filterByDistrict(listings: ReasListing[], requestedDistrict: string): ReasListing[] {
    if (!/^Praha\s+\d+$/i.test(requestedDistrict.trim())) {
        return listings;
    }

    return listings.filter((listing) =>
        matchesRequestedDistrict({
            requestedDistrict,
            locality: [
                listing.formattedAddress,
                listing.formattedLocation,
                listing.cadastralAreaSlug,
                listing.municipalitySlug,
            ].join(" "),
        })
    );
}

interface ReasClientConfig {
    apiClient?: Pick<ApiClient, "get">;
}

export class ReasClient {
    private readonly apiClient: Pick<ApiClient, "get">;

    constructor(config: ReasClientConfig = {}) {
        this.apiClient =
            config.apiClient ??
            new ApiClient({
                baseUrl: BASE_URL,
                loggerContext: { provider: "reas" },
            });
    }

    buildQueryParams(filters: AnalysisFilters, dateRange: DateRange): URLSearchParams {
        return buildReasQueryParams(filters, dateRange);
    }

    async fetchSoldCount(filters: AnalysisFilters, dateRange: DateRange): Promise<number> {
        const params = this.buildQueryParams(filters, dateRange);
        const body = await this.apiClient.get<CountResponse>("/listings/count", { params });

        return body.data.count;
    }

    async fetchPointersAndClusters(
        filters: AnalysisFilters,
        dateRange: DateRange
    ): Promise<PointersAndClustersResponse["data"]> {
        const params = this.buildQueryParams(filters, dateRange);
        const body = await this.apiClient.get<PointersAndClustersResponse>("/listings/pointers-and-clusters", {
            params,
        });

        return body.data;
    }

    async fetchSoldListings(filters: AnalysisFilters, dateRange: DateRange, refresh = false): Promise<ReasListing[]> {
        const keyParams = buildCacheKeyParams(filters, dateRange);
        const key = cacheKey(keyParams);

        if (!refresh) {
            const cached = await getCached<ReasListing>(key, REAS_TTL);

            if (cached) {
                return cached.data;
            }
        }

        const allListings: ReasListing[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const params = this.buildQueryParams(filters, dateRange);
            params.set("page", String(page));
            params.set("limit", String(PAGE_LIMIT));

            const body = await this.apiClient.get<ListingsResponse>("/listings", { params });
            allListings.push(...body.data);

            if (body.nextPage !== null && page < MAX_PAGES) {
                page = body.nextPage;
            } else {
                hasMore = false;
            }
        }

        const listings = filterByDistrict(filterByDisposition(allListings, filters.disposition), filters.district.name);

        const entry: CacheEntry<ReasListing> = {
            fetchedAt: new Date().toISOString(),
            params: keyParams,
            count: listings.length,
            data: listings,
        };

        await setCache(key, entry);

        return listings;
    }
}

export const reasClient = new ReasClient();
