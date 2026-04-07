import type {
    BezrealitkyAdvertData,
    BezrealitkyAdvertDetail,
    BezrealitkyAdvertListRaw,
    BezrealitkyAdvertRaw,
    BezrealitkyAutocompleteResponse,
    BezrealitkyClientOptions,
    BezrealitkyFormattedParameter,
    BezrealitkyGraphqlResponse,
    BezrealitkyImage,
    BezrealitkyListAdvertsData,
    BezrealitkyMortgageData,
    BezrealitkyRegionNode,
} from "@app/Internal/commands/reas/api/BezrealitkyClient.types";
import { cacheKey, getCached, SREALITY_TTL, setCache } from "@app/Internal/commands/reas/cache/index";
import { matchesRequestedDistrict } from "@app/Internal/commands/reas/lib/district-matching";
import type {
    AnalysisFilters,
    CacheEntry,
    ProviderLink,
    RentalListing,
    SaleListing,
} from "@app/Internal/commands/reas/types";
import { ApiClient } from "@app/utils/api/ApiClient";
import { SafeJSON } from "@app/utils/json";

const GRAPHQL_URL = "https://api.bezrealitky.cz/graphql/";
const AUTOCOMPLETE_URL = "https://autocomplete.bezrealitky.cz";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const CURRENCY = "CZK";
const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const RENTAL_CONTRACT = "graphql:listAdverts" as const;
const DETAIL_CONTRACT = "graphql:advert" as const;

const DISPOSITION_MAP: Record<string, string> = {
    DISP_1_KK: "1+kk",
    DISP_1_1: "1+1",
    DISP_2_KK: "2+kk",
    DISP_2_1: "2+1",
    DISP_3_KK: "3+kk",
    DISP_3_1: "3+1",
    DISP_4_KK: "4+kk",
    DISP_4_1: "4+1",
    DISP_5_KK: "5+kk",
    DISP_5_1: "5+1",
};

const REVERSE_DISPOSITION_MAP = Object.fromEntries(
    Object.entries(DISPOSITION_MAP).map(([key, value]) => [value, key])
) as Record<string, string>;

const CONSTRUCTION_MAP: Record<string, string> = {
    brick: "BRICK",
    panel: "PANEL",
};

const ESTATE_TYPE_MAP: Record<string, string> = {
    flat: "BYT",
    house: "DUM",
    land: "POZEMEK",
};

const LIST_ADVERTS_QUERY = `
    query ListAdverts(
        $limit: Int
        $offset: Int
        $offerType: [OfferType]
        $estateType: [EstateType]
        $construction: [Construction]
        $currency: Currency
        $regionOsmIds: [ID]
        $disposition: [Disposition]
    ) {
        listAdverts(
            limit: $limit
            offset: $offset
            order: TIMEORDER_DESC
            offerType: $offerType
            estateType: $estateType
            construction: $construction
            currency: $currency
            regionOsmIds: $regionOsmIds
            disposition: $disposition
        ) {
            totalCount
            list {
                id
                uri
                offerType
                disposition
                surface
                price
                charges
                reserved
                gps {
                    lat
                    lng
                }
                address(locale: CS)
                imageAltText(locale: CS)
                originalPrice
                isDiscounted
                availableFrom
                links {
                    url
                    type
                    status
                }
            }
        }
    }
`;

const ADVERT_DETAIL_QUERY = `
    query Advert($id: ID!) {
        advert(id: $id) {
            id
            uri
            offerType
            disposition
            surface
            price
            charges
            serviceCharges
            utilityCharges
            deposit
            availableFrom
            originalPrice
            isDiscounted
            gps {
                lat
                lng
            }
            address(locale: CS)
            imageAltText(locale: CS)
            mortgageData(locale: CS) {
                rateLow
                rateHigh
                years
                loan
            }
            links {
                url
                type
                status
            }
            publicImages(limit: 12) {
                id
                order
                url(filter: RECORD_MAIN)
            }
            formattedAds(locale: CS) {
                title
                value
                valueHref
            }
            poiData
            regionTree(locale: CS) {
                id
                name
                uri
            }
            relatedAdverts(limit: 6) {
                list {
                    id
                    uri
                    offerType
                    disposition
                    surface
                    price
                    charges
                    reserved
                    gps {
                        lat
                        lng
                    }
                    address(locale: CS)
                    imageAltText(locale: CS)
                    originalPrice
                    isDiscounted
                    availableFrom
                    links {
                        url
                        type
                        status
                    }
                }
            }
            nemoreport {
                id
                timeCreated
                resultUrl
                status
                message
            }
        }
    }
`;

function getAddress(raw: BezrealitkyAdvertRaw): string {
    if (typeof raw.address === "string") {
        return raw.address;
    }

    const address = raw['address({"locale":"CS"})'];

    if (typeof address === "string") {
        return address;
    }

    return "";
}

function getImageAltText(raw: BezrealitkyAdvertRaw): string | undefined {
    if (typeof raw.imageAltText === "string") {
        return raw.imageAltText;
    }

    const imageAltText = raw['imageAltText({"locale":"CS"})'];

    if (typeof imageAltText === "string") {
        return imageAltText;
    }

    return undefined;
}

function getMortgageData(raw: BezrealitkyAdvertRaw): BezrealitkyMortgageData | null | undefined {
    if (raw.mortgageData && typeof raw.mortgageData === "object") {
        const candidate = raw.mortgageData as Record<string, unknown>;
        return {
            rateLow: typeof candidate.rateLow === "number" ? candidate.rateLow : null,
            rateHigh: typeof candidate.rateHigh === "number" ? candidate.rateHigh : null,
            years: typeof candidate.years === "number" ? candidate.years : null,
            loan: typeof candidate.loan === "number" ? candidate.loan : null,
        };
    }

    const mortgageData = raw['mortgageData({"locale":"CS"})'];

    if (!mortgageData || typeof mortgageData !== "object") {
        return undefined;
    }

    const candidate = mortgageData as Record<string, unknown>;
    return {
        rateLow: typeof candidate.rateLow === "number" ? candidate.rateLow : null,
        rateHigh: typeof candidate.rateHigh === "number" ? candidate.rateHigh : null,
        years: typeof candidate.years === "number" ? candidate.years : null,
        loan: typeof candidate.loan === "number" ? candidate.loan : null,
    };
}

function getRegionTree(raw: BezrealitkyAdvertRaw): BezrealitkyRegionNode[] {
    if (Array.isArray(raw.regionTree)) {
        return raw.regionTree.flatMap((region) => {
            if (!region || typeof region !== "object") {
                return [];
            }

            const candidate = region as Record<string, unknown>;
            if (typeof candidate.id !== "string" || typeof candidate.name !== "string") {
                return [];
            }

            return [
                {
                    id: candidate.id,
                    name: candidate.name,
                    uri: typeof candidate.uri === "string" ? candidate.uri : null,
                },
            ];
        });
    }

    const regionTree = raw['regionTree({"locale":"CS"})'];

    if (!Array.isArray(regionTree)) {
        return [];
    }

    return regionTree.flatMap((region) => {
        if (!region || typeof region !== "object") {
            return [];
        }

        const candidate = region as Record<string, unknown>;
        if (typeof candidate.id !== "string" || typeof candidate.name !== "string") {
            return [];
        }

        return [
            {
                id: candidate.id,
                name: candidate.name,
                uri: typeof candidate.uri === "string" ? candidate.uri : null,
            },
        ];
    });
}

function getRelatedAdvertList(raw: BezrealitkyAdvertRaw): BezrealitkyAdvertRaw[] {
    if (raw.relatedAdverts && typeof raw.relatedAdverts === "object") {
        const list = (raw.relatedAdverts as Record<string, unknown>).list;

        if (Array.isArray(list)) {
            return list.filter(
                (item): item is BezrealitkyAdvertRaw => !!item && typeof item === "object"
            ) as BezrealitkyAdvertRaw[];
        }
    }

    const related = raw['relatedAdverts({"limit":6})'];

    if (!related || typeof related !== "object") {
        return [];
    }

    const list = (related as Record<string, unknown>).list;
    if (!Array.isArray(list)) {
        return [];
    }

    return list.filter(
        (item): item is BezrealitkyAdvertRaw => !!item && typeof item === "object"
    ) as BezrealitkyAdvertRaw[];
}

function parsePoiData(rawPoiData: string | null | undefined): Record<string, unknown> | null {
    if (!rawPoiData) {
        return null;
    }

    try {
        const parsed = SafeJSON.parse(rawPoiData);

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }

        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function normalizeLinks(links: ProviderLink[] | null | undefined): ProviderLink[] {
    if (!Array.isArray(links)) {
        return [];
    }

    return links.filter((link) => typeof link?.url === "string");
}

function getPublicImages(raw: BezrealitkyAdvertRaw): BezrealitkyImage[] {
    if (!Array.isArray(raw.publicImages)) {
        return [];
    }

    return raw.publicImages
        .flatMap((image) => {
            if (!image || typeof image !== "object") {
                return [];
            }

            const candidate = image as Record<string, unknown>;

            if (typeof candidate.id !== "string" || typeof candidate.url !== "string") {
                return [];
            }

            return [
                {
                    id: candidate.id,
                    order: typeof candidate.order === "number" ? candidate.order : null,
                    url: candidate.url,
                } satisfies BezrealitkyImage,
            ];
        })
        .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));
}

function getFormattedAds(raw: BezrealitkyAdvertRaw): BezrealitkyFormattedParameter[] {
    if (!Array.isArray(raw.formattedAds)) {
        return [];
    }

    return raw.formattedAds.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
            return [];
        }

        const candidate = entry as Record<string, unknown>;

        return [
            {
                title: typeof candidate.title === "string" ? candidate.title : null,
                value: typeof candidate.value === "string" ? candidate.value : null,
                valueHref: typeof candidate.valueHref === "string" ? candidate.valueHref : null,
            } satisfies BezrealitkyFormattedParameter,
        ];
    });
}

function buildAdvertLink(uri: string): string {
    return `https://www.bezrealitky.cz/nemovitosti-byty-domy/${uri}`;
}

function mapEstateType(estateType: string): string[] {
    const mapped = ESTATE_TYPE_MAP[estateType];

    if (!mapped) {
        return [];
    }

    return [mapped];
}

function mapConstructionType(constructionType: string): string[] {
    const mapped = CONSTRUCTION_MAP[constructionType];

    if (!mapped) {
        return [];
    }

    return [mapped];
}

function mapDispositionFilter(disposition: string | undefined): string[] {
    if (!disposition) {
        return [];
    }

    const mapped = REVERSE_DISPOSITION_MAP[disposition];

    if (!mapped) {
        return [];
    }

    return [mapped];
}

function toOfferType(contractType: "rental" | "sale"): "PRONAJEM" | "PRODEJ" {
    if (contractType === "sale") {
        return "PRODEJ";
    }

    return "PRONAJEM";
}

function buildCacheKeyParams(filters: AnalysisFilters, contractType: "rental" | "sale"): Record<string, unknown> {
    return {
        source: "bezrealitky",
        contractType,
        districtName: filters.district.name,
        estateType: filters.estateType,
        constructionType: filters.constructionType,
        disposition: filters.disposition ?? null,
    };
}

function getNumericValue(value: unknown): number | undefined {
    if (typeof value === "number") {
        return value;
    }

    return undefined;
}

function getCoordinates(raw: BezrealitkyAdvertRaw): { lat: number; lng: number } | undefined {
    if (!raw.gps) {
        return undefined;
    }

    return {
        lat: raw.gps.lat,
        lng: raw.gps.lng,
    };
}

export function mapBezrealitkyDisposition(bzrDisposition: string): string {
    return DISPOSITION_MAP[bzrDisposition] ?? bzrDisposition;
}

export function extractRegionOsmIds(response: BezrealitkyAutocompleteResponse): string[] {
    const ids = new Set<string>();

    for (const feature of response.features ?? []) {
        const osmType = feature.properties?.osm_type;
        const osmId = feature.properties?.osm_id;

        if (!osmType || osmId === undefined || osmId === null) {
            continue;
        }

        ids.add(`${osmType.toUpperCase()}${osmId}`);
    }

    return [...ids];
}

function mapRentalListing(raw: BezrealitkyAdvertRaw, sourceContract: string): RentalListing | null {
    if (raw.reserved) {
        return null;
    }

    return {
        id: `bezrealitky-${raw.id}`,
        source: "bezrealitky",
        sourceId: raw.id,
        sourceContract,
        type: "rental",
        name: getImageAltText(raw),
        price: raw.price ?? 0,
        locality: getAddress(raw),
        disposition: raw.disposition ? mapBezrealitkyDisposition(raw.disposition) : undefined,
        area: getNumericValue(raw.surface),
        link: buildAdvertLink(raw.uri),
        charges: getNumericValue(raw.charges),
        coordinates: getCoordinates(raw),
        labels: [],
        uri: raw.uri,
        originalPrice: getNumericValue(raw.originalPrice),
        isDiscounted: raw.isDiscounted ?? undefined,
        availableFrom: raw.availableFrom ?? undefined,
        imageAltText: getImageAltText(raw),
        links: normalizeLinks(raw.links),
        rawData: raw,
    };
}

function mapSaleListing(raw: BezrealitkyAdvertRaw, sourceContract: string): SaleListing | null {
    if (raw.reserved) {
        return null;
    }

    return {
        id: `bezrealitky-${raw.id}`,
        source: "bezrealitky",
        sourceId: raw.id,
        sourceContract,
        type: "sale",
        price: raw.price ?? 0,
        address: getAddress(raw),
        disposition: raw.disposition ? mapBezrealitkyDisposition(raw.disposition) : undefined,
        area: getNumericValue(raw.surface),
        link: buildAdvertLink(raw.uri),
        coordinates: getCoordinates(raw),
        originalPrice: getNumericValue(raw.originalPrice),
        isDiscounted: raw.isDiscounted ?? undefined,
        imageAltText: getImageAltText(raw),
        uri: raw.uri,
        links: normalizeLinks(raw.links),
        rawData: raw,
    };
}

function matchesDisposition(listing: RentalListing | SaleListing, disposition: string | undefined): boolean {
    if (!disposition) {
        return true;
    }

    return listing.disposition === disposition;
}

function matchesRequestedListingDistrict(listing: RentalListing | SaleListing, requestedDistrict: string): boolean {
    const locality = "address" in listing ? listing.address : listing.locality;

    return matchesRequestedDistrict({ requestedDistrict, locality });
}

export class BezrealitkyClient {
    private readonly graphqlClient: ApiClient;
    private readonly autocompleteClient: ApiClient;
    private readonly pageSize: number;

    constructor(options: BezrealitkyClientOptions = {}) {
        this.graphqlClient =
            options.graphqlClient ??
            new ApiClient({
                baseUrl: GRAPHQL_URL,
                userAgent: BROWSER_USER_AGENT,
                headers: {
                    "Content-Type": "application/json",
                    Origin: "https://www.bezrealitky.cz",
                    Referer: "https://www.bezrealitky.cz/",
                    "Accept-Language": "cs",
                },
                loggerContext: { provider: "bezrealitky", api: "graphql" },
            });
        this.autocompleteClient =
            options.autocompleteClient ??
            new ApiClient({
                baseUrl: AUTOCOMPLETE_URL,
                userAgent: BROWSER_USER_AGENT,
                headers: {
                    Referer: "https://www.bezrealitky.cz/",
                    "Accept-Language": "cs",
                },
                loggerContext: { provider: "bezrealitky", api: "autocomplete" },
            });
        this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    }

    async resolveRegionOsmIds(query: string, size = 5): Promise<string[]> {
        const response = await this.autocompleteClient.get<BezrealitkyAutocompleteResponse & { error?: string }>(
            "/autocomplete",
            {
                params: {
                    q: query,
                    size,
                    address: 0,
                    preferredCountry: "cz",
                },
            }
        );

        if (response.error) {
            throw new Error(`Bezrealitky autocomplete failed: ${response.error}`);
        }

        return extractRegionOsmIds(response);
    }

    async fetchRentalListings(filters: AnalysisFilters, refresh = false): Promise<RentalListing[]> {
        const result = await this.fetchListings(filters, "rental", refresh);
        return result.filter((listing): listing is RentalListing => listing.type === "rental");
    }

    async fetchSaleListings(filters: AnalysisFilters, refresh = false): Promise<SaleListing[]> {
        const result = await this.fetchListings(filters, "sale", refresh);
        return result.filter((listing): listing is SaleListing => listing.type === "sale");
    }

    async fetchAdvertDetail(advertIdOrUri: string): Promise<BezrealitkyAdvertDetail> {
        const advertId = advertIdOrUri.split("-")[0];
        const response = await this.graphqlClient.post<BezrealitkyGraphqlResponse<BezrealitkyAdvertData>>("", {
            operationName: "Advert",
            query: ADVERT_DETAIL_QUERY,
            variables: { id: advertId },
        });
        const data = this.unwrapResponse<BezrealitkyAdvertData>(response, "advert");
        const advert = data.advert;

        if (!advert) {
            throw new Error(`Bezrealitky advert ${advertId} was not found`);
        }

        const type = advert.offerType === "PRODEJ" ? "sale" : "rental";
        const relatedAdverts = getRelatedAdvertList(advert)
            .map((relatedAdvert) => {
                if (type === "sale") {
                    return mapSaleListing(relatedAdvert, RENTAL_CONTRACT);
                }

                return mapRentalListing(relatedAdvert, RENTAL_CONTRACT);
            })
            .filter((listing): listing is RentalListing | SaleListing => listing !== null);

        return {
            id: advert.id,
            source: "bezrealitky",
            sourceId: advert.id,
            sourceContract: DETAIL_CONTRACT,
            type,
            uri: advert.uri,
            link: buildAdvertLink(advert.uri),
            address: getAddress(advert),
            disposition: advert.disposition ? mapBezrealitkyDisposition(advert.disposition) : undefined,
            surface: getNumericValue(advert.surface),
            price: advert.price ?? 0,
            charges: getNumericValue(advert.charges),
            serviceCharges: getNumericValue(advert.serviceCharges),
            utilityCharges: getNumericValue(advert.utilityCharges),
            deposit: getNumericValue(advert.deposit),
            availableFrom: advert.availableFrom ?? undefined,
            originalPrice: getNumericValue(advert.originalPrice),
            isDiscounted: advert.isDiscounted ?? undefined,
            imageAltText: getImageAltText(advert),
            mortgageData: getMortgageData(advert),
            links: normalizeLinks(advert.links),
            poiData: parsePoiData(advert.poiData),
            regionTree: getRegionTree(advert),
            publicImages: getPublicImages(advert),
            formattedAds: getFormattedAds(advert),
            relatedAdverts,
            nemoreport: advert.nemoreport,
            coordinates: getCoordinates(advert),
            rawData: advert,
        };
    }

    private async fetchListings(
        filters: AnalysisFilters,
        contractType: "rental" | "sale",
        refresh: boolean
    ): Promise<Array<RentalListing | SaleListing>> {
        const keyParams = buildCacheKeyParams(filters, contractType);
        const key = cacheKey(keyParams);

        if (!refresh) {
            const cached = await getCached<RentalListing | SaleListing>(key, SREALITY_TTL);

            if (cached) {
                return cached.data;
            }
        }

        const regionOsmIds = await this.resolveRegionOsmIds(filters.district.name);

        if (regionOsmIds.length === 0) {
            return [];
        }

        const allListings: Array<RentalListing | SaleListing> = [];
        let offset = 0;
        let page = 0;
        let totalCount = Number.POSITIVE_INFINITY;

        while (offset < totalCount && page < MAX_PAGES) {
            const advertList = await this.fetchAdvertPage({
                limit: this.pageSize,
                offset,
                offerType: toOfferType(contractType),
                filters,
                regionOsmIds,
            });
            const mappedListings = advertList.list
                .map((advert) => {
                    if (contractType === "sale") {
                        return mapSaleListing(advert, RENTAL_CONTRACT);
                    }

                    return mapRentalListing(advert, RENTAL_CONTRACT);
                })
                .filter((listing): listing is RentalListing | SaleListing => listing !== null)
                .filter((listing) => matchesDisposition(listing, filters.disposition))
                .filter((listing) => matchesRequestedListingDistrict(listing, filters.district.name));

            allListings.push(...mappedListings);
            totalCount = advertList.totalCount;

            if (advertList.list.length < this.pageSize) {
                break;
            }

            offset += this.pageSize;
            page++;
        }

        const entry: CacheEntry<RentalListing | SaleListing> = {
            fetchedAt: new Date().toISOString(),
            params: keyParams,
            count: allListings.length,
            data: allListings,
        };

        await setCache(key, entry);

        return allListings;
    }

    private async fetchAdvertPage(args: {
        limit: number;
        offset: number;
        offerType: "PRONAJEM" | "PRODEJ";
        filters: AnalysisFilters;
        regionOsmIds: string[];
    }): Promise<BezrealitkyAdvertListRaw> {
        const response = await this.graphqlClient.post<BezrealitkyGraphqlResponse<BezrealitkyListAdvertsData>>("", {
            operationName: "ListAdverts",
            query: LIST_ADVERTS_QUERY,
            variables: {
                limit: args.limit,
                offset: args.offset,
                offerType: [args.offerType],
                estateType: mapEstateType(args.filters.estateType),
                construction: mapConstructionType(args.filters.constructionType),
                currency: CURRENCY,
                regionOsmIds: args.regionOsmIds,
                disposition: mapDispositionFilter(args.filters.disposition),
            },
        });
        const data = this.unwrapResponse<BezrealitkyListAdvertsData>(response, "listAdverts");

        return data.listAdverts ?? { totalCount: 0, list: [] };
    }

    private unwrapResponse<T>(response: BezrealitkyGraphqlResponse<T>, operation: string): T {
        if (response.errors && response.errors.length > 0) {
            const message = response.errors
                .map((error) => error.message)
                .filter(Boolean)
                .join("; ");
            throw new Error(`Bezrealitky ${operation} failed: ${message}`);
        }

        if (!response.data) {
            throw new Error(`Bezrealitky ${operation} returned no data`);
        }

        return response.data;
    }
}
