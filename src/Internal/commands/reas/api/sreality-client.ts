import { cacheKey, getCached, SREALITY_TTL, setCache } from "../cache/index";
import type { AnalysisFilters, CacheEntry, SrealityRental } from "../types";

const BASE_URL = "https://www.sreality.cz/api/cs/v2";
const PER_PAGE = 60;

const DISPOSITION_MAP: Record<string, number> = {
    "1+kk": 2,
    "1+1": 3,
    "2+kk": 4,
    "2+1": 5,
    "3+kk": 6,
    "3+1": 7,
    "4+kk": 8,
    "4+1": 9,
    "5+kk": 10,
    "5+1": 11,
};

const BUILDING_TYPE_MAP: Record<string, number> = {
    panel: 1,
    brick: 2,
};

interface SrealityEstateRaw {
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

interface SrealityListResponse {
    _embedded: { estates: SrealityEstateRaw[] };
    result_size: number;
    per_page: number;
    page: number;
}

interface SrealitySuggestItem {
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

interface SrealitySuggestResponse {
    count: number;
    data: SrealitySuggestItem[];
}

export interface SuggestResult {
    value: string;
    regionType: string;
    regionId: number;
    districtId: number;
    municipality: string;
}

const NAME_REGEX = /Pron[aá]jem\s+bytu\s+(\d\+(?:kk|1))\s+(\d+)\s*m/i;

/**
 * Parse a Sreality listing name like "Pronájem bytu 3+1 68 m²"
 * to extract disposition and area.
 */
export function parseSrealityName(name: string): { disposition?: string; area?: number } {
    const match = NAME_REGEX.exec(name);

    if (!match) {
        return {};
    }

    return {
        disposition: match[1],
        area: Number(match[2]),
    };
}

function buildSearchParams(filters: AnalysisFilters, page: number): URLSearchParams {
    const params = new URLSearchParams();

    params.set("category_main_cb", "1");
    params.set("category_type_cb", "2");
    params.set("locality_district_id", String(filters.district.srealityId));
    params.set("per_page", String(PER_PAGE));
    params.set("page", String(page));
    params.set("tms", String(Date.now()));

    if (filters.disposition) {
        const subCb = DISPOSITION_MAP[filters.disposition];

        if (subCb !== undefined) {
            params.set("category_sub_cb", String(subCb));
        }
    }

    if (filters.constructionType) {
        const buildingType = BUILDING_TYPE_MAP[filters.constructionType];

        if (buildingType !== undefined) {
            params.set("building_type_search", String(buildingType));
        }
    }

    return params;
}

function buildCacheKeyParams(filters: AnalysisFilters): Record<string, unknown> {
    return {
        source: "sreality",
        districtId: filters.district.srealityId,
        disposition: filters.disposition ?? null,
        constructionType: filters.constructionType,
    };
}

function buildSrealityLink(raw: SrealityEstateRaw): string {
    const seoLocality = raw.seo?.locality ?? "";

    if (seoLocality) {
        return `https://www.sreality.cz/detail/pronajem/byt/${seoLocality}/${raw.hash_id}`;
    }

    return `https://www.sreality.cz/detail/pronajem/byt/${raw.hash_id}`;
}

function mapEstate(raw: SrealityEstateRaw): SrealityRental {
    const parsed = parseSrealityName(raw.name);

    return {
        hash_id: raw.hash_id,
        name: raw.name,
        price: raw.price,
        locality: raw.locality,
        gps: raw.gps,
        labels: raw.labels ?? [],
        disposition: parsed.disposition,
        area: parsed.area,
        link: buildSrealityLink(raw),
    };
}

/**
 * Fetch rental listings from Sreality.cz with auto-pagination.
 * Results are cached for 6 hours; pass refresh=true to bypass cache.
 */
export async function fetchRentalListings(filters: AnalysisFilters, refresh = false): Promise<SrealityRental[]> {
    const keyParams = buildCacheKeyParams(filters);
    const key = cacheKey(keyParams);

    if (!refresh) {
        const cached = await getCached<SrealityRental>(key, SREALITY_TTL);

        if (cached) {
            return cached.data;
        }
    }

    const allListings: SrealityRental[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
        const params = buildSearchParams(filters, page);
        const url = `${BASE_URL}/estates?${params.toString()}`;

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Sreality API error (page ${page}): ${response.status} ${response.statusText}`);
        }

        const body = (await response.json()) as SrealityListResponse;
        const estates = body._embedded?.estates ?? [];

        for (const estate of estates) {
            allListings.push(mapEstate(estate));
        }

        if (estates.length === 0 || page * PER_PAGE >= body.result_size) {
            hasMore = false;
        } else {
            page++;
        }
    }

    const entry: CacheEntry<SrealityRental> = {
        fetchedAt: new Date().toISOString(),
        params: keyParams,
        count: allListings.length,
        data: allListings,
    };

    await setCache(key, entry);

    return allListings;
}

/**
 * Query the Sreality suggest endpoint to resolve a locality phrase
 * into region types and IDs.
 */
export async function suggestLocality(phrase: string): Promise<SuggestResult[]> {
    const params = new URLSearchParams();
    params.set("phrase", phrase);
    params.set("tms", String(Date.now()));

    const url = `${BASE_URL}/suggest?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Sreality suggest error: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as SrealitySuggestResponse;
    const suggestions = body.data ?? [];

    return suggestions.map((s) => ({
        value: s.userData.suggestFirstRow,
        regionType: s.userData.entityType,
        regionId: s.userData.municipality_id,
        districtId: s.userData.district_id,
        municipality: s.userData.municipality,
    }));
}
