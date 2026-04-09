import type {
    ParseSrealityNameResult,
    SrealityApiClientLike,
    SrealityCacheAdapter,
    SrealityClientConfig,
    SrealityCluster,
    SrealityClustersResponse,
    SrealityEstateRaw,
    SrealityGeometriesResponse,
    SrealityGeometry,
    SrealityGeometryQuery,
    SrealityHistogramBucket,
    SrealityHistogramResponse,
    SrealityListingMapper,
    SrealityListingRequest,
    SrealityListResponse,
    SrealityOfferType,
    SrealitySuggestResponse,
    SrealityV1QueryParams,
    SuggestResult,
} from "@app/Internal/commands/reas/api/SrealityClient.types";
import { SREALITY_V2_SOURCE_CONTRACT } from "@app/Internal/commands/reas/api/SrealityClient.types";
import { cacheKey, getCached, SREALITY_TTL, setCache } from "@app/Internal/commands/reas/cache/index";
import { getSrealityCategorySubCb } from "@app/Internal/commands/reas/data/disposition-map";
import { matchesRequestedDistrict } from "@app/Internal/commands/reas/lib/district-matching";
import type { AnalysisFilters, CacheEntry, SaleListing, SrealityRental } from "@app/Internal/commands/reas/types";
import { ApiClient } from "@app/utils/api/ApiClient";

const V1_BASE_URL = "https://www.sreality.cz/api/v1";
const V2_BASE_URL = "https://www.sreality.cz/api/cs/v2";
const PER_PAGE = 200;
const MAX_PAGES = 1000;

const BUILDING_TYPE_MAP: Record<string, number> = {
    panel: 1,
    brick: 2,
};

const OFFER_TYPE_CATEGORY_MAP: Record<SrealityOfferType, string> = {
    rental: "2",
    sale: "1",
};

const NAME_REGEX = /(?:Pron[aá]jem|Prodej)\s+bytu\s+(\d\+(?:kk|1))\s+(\d+)\s*m/i;

const DEFAULT_CACHE: SrealityCacheAdapter = {
    getCached,
    setCache,
};

function createApiClient(baseUrl: string, component: string): SrealityApiClientLike {
    return new ApiClient({
        baseUrl,
        loggerContext: {
            provider: "sreality",
            component,
        },
    });
}

export function parseSrealityName(name: string): ParseSrealityNameResult {
    const match = NAME_REGEX.exec(name);

    if (!match) {
        return {};
    }

    return {
        disposition: match[1],
        area: Number(match[2]),
    };
}

function buildCacheKeyParams(filters: AnalysisFilters, offerType: SrealityOfferType): Record<string, unknown> {
    return {
        source: "sreality",
        offerType,
        districtId: filters.district.srealityId,
        disposition: filters.disposition ?? null,
        constructionType: filters.constructionType,
    };
}

function buildV2SearchParams(filters: AnalysisFilters, offerType: SrealityOfferType, page: number): URLSearchParams {
    const params = new URLSearchParams();

    if ("srealityQuarterId" in filters.district && typeof filters.district.srealityQuarterId === "number") {
        params.set("locality_quarter_id", String(filters.district.srealityQuarterId));
    } else {
        const localityParam =
            filters.district.srealityLocality === "region" ? "locality_region_id" : "locality_district_id";

        params.set(localityParam, String(filters.district.srealityId));
    }

    params.set("category_main_cb", "1");
    params.set("category_type_cb", OFFER_TYPE_CATEGORY_MAP[offerType]);
    params.set("per_page", String(PER_PAGE));
    params.set("page", String(page));
    params.set("tms", String(Date.now()));

    if (filters.disposition) {
        const subCb = getSrealityCategorySubCb(filters.disposition);

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

// Reverse map: Sreality category_sub_cb → URL slug
const CATEGORY_SUB_CB_TO_SLUG: Record<number, string> = {
    2: "1-kk",
    3: "1-1",
    4: "2-kk",
    5: "2-1",
    6: "3-kk",
    7: "3-1",
    8: "4-kk",
    9: "4-1",
    10: "5-kk",
    11: "5-1",
    12: "6-kk",
    16: "atypicky",
    43: "pokoj",
    47: "6-1",
};

function buildSrealityLink(raw: SrealityEstateRaw, offerType: SrealityOfferType): string {
    const contractPath = offerType === "rental" ? "pronajem" : "prodej";
    const seoLocality = raw.seo?.locality ?? "";
    const subTypeSlug = raw.seo?.category_sub_cb ? CATEGORY_SUB_CB_TO_SLUG[raw.seo.category_sub_cb] : undefined;

    const segments = [`https://www.sreality.cz/detail/${contractPath}/byt`];

    if (subTypeSlug) {
        segments.push(subTypeSlug);
    }

    if (seoLocality) {
        segments.push(seoLocality);
    }

    segments.push(String(raw.hash_id));

    return segments.join("/");
}

function buildV1Path(pathname: string, params: SrealityV1QueryParams): string {
    const normalizedPathname = pathname.replace(/^\//, "");
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
            continue;
        }

        searchParams.set(key, String(value));
    }

    const queryString = searchParams.toString();

    if (!queryString) {
        return normalizedPathname;
    }

    return `${normalizedPathname}?${queryString}`;
}

function mapRentalEstate(raw: SrealityEstateRaw): SrealityRental {
    const parsed = parseSrealityName(raw.name);
    const id = String(raw.hash_id);

    return {
        id,
        source: "sreality",
        sourceId: id,
        sourceContract: SREALITY_V2_SOURCE_CONTRACT,
        type: "rental",
        hash_id: raw.hash_id,
        name: raw.name,
        price: raw.price,
        locality: raw.locality,
        gps: raw.gps,
        labels: raw.labels ?? [],
        disposition: parsed.disposition,
        area: parsed.area,
        link: buildSrealityLink(raw, "rental"),
    };
}

function mapSaleEstate(raw: SrealityEstateRaw): SaleListing {
    const parsed = parseSrealityName(raw.name);
    const area = parsed.area;
    const id = String(raw.hash_id);

    return {
        id,
        source: "sreality",
        sourceId: id,
        sourceContract: SREALITY_V2_SOURCE_CONTRACT,
        type: "sale",
        price: raw.price,
        address: raw.locality,
        disposition: parsed.disposition,
        area,
        pricePerM2: area ? Math.round(raw.price / area) : undefined,
        link: buildSrealityLink(raw, "sale"),
        coordinates: {
            lat: raw.gps.lat,
            lng: raw.gps.lon,
        },
        rawData: raw,
    };
}

export class SrealityClient {
    private readonly apiV1: SrealityApiClientLike;
    private readonly apiV2: SrealityApiClientLike;
    private readonly cache: SrealityCacheAdapter;

    constructor(config: SrealityClientConfig = {}) {
        this.apiV1 = config.apiV1 ?? createApiClient(V1_BASE_URL, "SrealityClient.v1");
        this.apiV2 = config.apiV2 ?? createApiClient(V2_BASE_URL, "SrealityClient.v2");
        this.cache = config.cache ?? DEFAULT_CACHE;
    }

    async fetchRentalListings(filters: AnalysisFilters, refresh = false): Promise<SrealityRental[]> {
        return this.fetchListings({
            filters,
            offerType: "rental",
            refresh,
            mapper: {
                sourceContract: SREALITY_V2_SOURCE_CONTRACT,
                mapEstate: mapRentalEstate,
            },
        });
    }

    async fetchSaleListings(filters: AnalysisFilters, refresh = false): Promise<SaleListing[]> {
        return this.fetchListings({
            filters,
            offerType: "sale",
            refresh,
            mapper: {
                sourceContract: SREALITY_V2_SOURCE_CONTRACT,
                mapEstate: mapSaleEstate,
            },
        });
    }

    async suggestLocality(phrase: string): Promise<SuggestResult[]> {
        const path = buildV2Path("/suggest", { phrase, tms: Date.now() });
        const body = await this.apiV2.get<SrealitySuggestResponse>(path);
        const suggestions = body.data ?? [];

        return suggestions.map((suggestion) => ({
            value: suggestion.userData.suggestFirstRow,
            regionType: suggestion.userData.entityType,
            regionId: suggestion.userData.municipality_id,
            districtId: suggestion.userData.district_id,
            municipality: suggestion.userData.municipality,
        }));
    }

    async fetchHistogram(params: SrealityV1QueryParams): Promise<SrealityHistogramBucket[]> {
        const path = buildV1Path("/estates/filter_page/histogram", params);
        const body = await this.apiV1.get<SrealityHistogramResponse>(path);
        return body.result?.histogram ?? [];
    }

    async fetchClusters(params: SrealityV1QueryParams): Promise<SrealityCluster[]> {
        const path = buildV1Path("/estates/search/clusters", params);
        const body = await this.apiV1.get<SrealityClustersResponse>(path);
        return body.results ?? [];
    }

    async fetchGeometries(query: SrealityGeometryQuery): Promise<SrealityGeometry[]> {
        const path = buildV1Path("/localities/geometries", {
            entity_id: query.entityId,
            entity_type: query.entityType,
            no_children: query.noChildren ?? true,
        });
        const body = await this.apiV1.get<SrealityGeometriesResponse>(path);
        return body.result ?? [];
    }

    private async fetchListings<TListing>(
        request: SrealityListingRequest & { mapper: SrealityListingMapper<TListing> }
    ): Promise<TListing[]> {
        const keyParams = buildCacheKeyParams(request.filters, request.offerType);
        const key = cacheKey(keyParams);

        if (!request.refresh) {
            const cached = await this.cache.getCached<TListing>(key, SREALITY_TTL);

            if (cached) {
                return cached.data;
            }
        }

        const listings: TListing[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const params = buildV2SearchParams(request.filters, request.offerType, page);
            const path = `estates?${params.toString()}`;
            const body = await this.apiV2.get<SrealityListResponse>(path);
            const estates = body._embedded?.estates ?? [];

            for (const estate of estates) {
                if (
                    !matchesRequestedDistrict({
                        requestedDistrict: request.filters.district.name,
                        locality: estate.locality,
                    })
                ) {
                    continue;
                }

                listings.push(request.mapper.mapEstate(estate));
            }

            if (estates.length === 0 || page * PER_PAGE >= body.result_size || page >= MAX_PAGES) {
                hasMore = false;
            } else {
                page++;
            }
        }

        const entry: CacheEntry<TListing> = {
            fetchedAt: new Date().toISOString(),
            params: {
                ...keyParams,
                sourceContract: request.mapper.sourceContract,
            },
            count: listings.length,
            data: listings,
        };

        await this.cache.setCache(key, entry);

        return listings;
    }
}

function buildV2Path(pathname: string, params: Record<string, string | number>): string {
    const normalizedPathname = pathname.replace(/^\//, "");
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        searchParams.set(key, String(value));
    }

    return `${normalizedPathname}?${searchParams.toString()}`;
}

export type {
    SrealityClientConfig,
    SrealityCluster,
    SrealityGeometry,
    SrealityGeometryQuery,
    SrealityHistogramBucket,
    SrealityOfferType,
    SrealityV1QueryParams,
    SuggestResult,
} from "@app/Internal/commands/reas/api/SrealityClient.types";
