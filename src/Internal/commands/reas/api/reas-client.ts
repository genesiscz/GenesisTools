import { getCached, setCache, cacheKey, REAS_TTL } from "../cache/index";
import type { ReasListing, AnalysisFilters, DateRange, CacheEntry } from "../types";

const BASE_URL = "https://catalog.reas.cz/catalog";
const CLIENT_ID = "6988cb437c5b9d2963280369";
const PAGE_LIMIT = 20;

interface CountResponse {
    success: boolean;
    data: { count: number };
}

interface ListingsResponse {
    success: boolean;
    data: ReasListing[];
    page: number;
    limit: number;
    nextPage: number | null;
}

/**
 * Build base query params shared by both count and listings endpoints.
 * Note: disposition (rooms) filtering is NOT supported by the API —
 * it must be applied client-side after fetching.
 */
function buildQueryParams(filters: AnalysisFilters, dateRange: DateRange): URLSearchParams {
    const params = new URLSearchParams();

    params.set("estateTypes", JSON.stringify([filters.estateType]));
    params.set("constructionType", JSON.stringify([filters.constructionType]));

    const soldDateRange = {
        from: dateRange.from.toISOString(),
        to: dateRange.to.toISOString(),
    };
    params.set("soldDateRange", JSON.stringify(soldDateRange));

    params.set("linkedToTransfer", "true");
    params.set("locality", JSON.stringify({ districtId: filters.district.reasId }));
    params.set("clientId", CLIENT_ID);

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

/**
 * Filter listings by disposition client-side.
 * The reas.cz API does not support the `rooms` query param,
 * so we fetch all listings and filter here.
 */
function filterByDisposition(listings: ReasListing[], disposition: string | undefined): ReasListing[] {
    if (!disposition) {
        return listings;
    }

    return listings.filter((l) => l.disposition === disposition);
}

/**
 * Fetch the count of sold listings matching the given filters.
 * Note: count is pre-disposition-filter (API doesn't support rooms param).
 * If disposition filtering is needed, use fetchSoldListings and check .length.
 */
export async function fetchSoldCount(filters: AnalysisFilters, dateRange: DateRange): Promise<number> {
    const params = buildQueryParams(filters, dateRange);
    const url = `${BASE_URL}/listings/count?${params.toString()}`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Reas API error (count): ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as CountResponse;
    return body.data.count;
}

/**
 * Fetch all sold listings matching the given filters, with auto-pagination.
 * Results are cached; pass refresh=true to bypass cache.
 * Disposition filtering is applied client-side.
 */
export async function fetchSoldListings(
    filters: AnalysisFilters,
    dateRange: DateRange,
    refresh = false,
): Promise<ReasListing[]> {
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
        const params = buildQueryParams(filters, dateRange);
        params.set("page", String(page));
        params.set("limit", String(PAGE_LIMIT));

        const url = `${BASE_URL}/listings?${params.toString()}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Reas API error (listings page ${page}): ${response.status} ${response.statusText}`);
        }

        const body = (await response.json()) as ListingsResponse;
        allListings.push(...body.data);

        if (body.nextPage !== null) {
            page = body.nextPage;
        } else {
            hasMore = false;
        }
    }

    const listings = filterByDisposition(allListings, filters.disposition);

    const entry: CacheEntry<ReasListing> = {
        fetchedAt: new Date().toISOString(),
        params: keyParams,
        count: listings.length,
        data: listings,
    };

    await setCache(key, entry);

    return listings;
}
