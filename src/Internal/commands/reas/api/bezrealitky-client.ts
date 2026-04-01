import { cacheKey, getCached, SREALITY_TTL, setCache } from "@app/Internal/commands/reas/cache/index";
import type { AnalysisFilters, CacheEntry } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";

const BASE_URL = "https://www.bezrealitky.cz/vypis/nabidka-pronajem/byt";
const PER_PAGE = 15;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";

export interface BezrealitkyListing {
    id: string;
    uri: string;
    disposition: string;
    area: number;
    price: number;
    charges: number;
    address: string;
    gps: { lat: number; lng: number };
    link: string;
}

/**
 * Bezrealitky region IDs for major Czech cities.
 * These are internal Bezrealitky region identifiers (not OSM or ARES IDs).
 */
export const BEZREALITKY_REGIONS: Record<string, string> = {
    "Hradec Králové": "9828",
    Praha: "486",
    Brno: "12547",
    Ostrava: "12232",
    Olomouc: "12116",
    Liberec: "9830",
    Pardubice: "10290",
    "České Budějovice": "9412",
    "Ústí nad Labem": "7836",
    Zlín: "13265",
    "Karlovy Vary": "7550",
    Jihlava: "10488",
    Plzeň: "7150",
};

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

/**
 * Map Bezrealitky disposition format (DISP_3_KK) to standard format (3+kk).
 */
export function mapBezrealitkyDisposition(bzrDisposition: string): string {
    return DISPOSITION_MAP[bzrDisposition] ?? bzrDisposition;
}

interface BzrAdvertRaw {
    __typename: string;
    id: string;
    uri: string;
    disposition: string;
    surface: number;
    price: number;
    charges: number;
    currency: string;
    reserved: boolean;
    gps: { lat: number; lng: number };
    [key: string]: unknown;
}

interface BzrNextData {
    props?: {
        pageProps?: {
            apolloCache?: Record<string, unknown>;
        };
    };
}

/**
 * Parse Bezrealitky's __NEXT_DATA__ JSON (Apollo cache) into listings.
 * Extracts Advert objects from the cache, skipping reserved ones.
 */
export function parseBezrealitkyNextData(nextData: BzrNextData): BezrealitkyListing[] {
    const cache = nextData?.props?.pageProps?.apolloCache;

    if (!cache) {
        return [];
    }

    const listings: BezrealitkyListing[] = [];

    for (const [key, value] of Object.entries(cache)) {
        if (!key.startsWith("Advert:")) {
            continue;
        }

        const advert = value as BzrAdvertRaw;

        if (advert.reserved) {
            continue;
        }

        // Address is stored with locale key pattern
        const addressKey = Object.keys(advert).find((k) => k.startsWith("address("));
        const address = addressKey ? String(advert[addressKey]) : "";

        listings.push({
            id: advert.id,
            uri: advert.uri,
            disposition: mapBezrealitkyDisposition(advert.disposition),
            area: advert.surface ?? 0,
            price: advert.price ?? 0,
            charges: advert.charges ?? 0,
            address,
            gps: {
                lat: advert.gps?.lat ?? 0,
                lng: advert.gps?.lng ?? 0,
            },
            link: `https://www.bezrealitky.cz/nemovitosti-byty-domy/${advert.uri}`,
        });
    }

    return listings;
}

/**
 * Extract __NEXT_DATA__ JSON from the HTML page.
 */
function extractNextData(html: string): BzrNextData | null {
    const match = /__NEXT_DATA__[^>]*>(.*?)<\/script>/s.exec(html);

    if (!match) {
        return null;
    }

    try {
        return SafeJSON.parse(match[1]) as BzrNextData;
    } catch {
        return null;
    }
}

function buildCacheKeyParams(filters: AnalysisFilters): Record<string, unknown> {
    return {
        source: "bezrealitky",
        districtName: filters.district.name,
        disposition: filters.disposition ?? null,
    };
}

function getBezrealitkySlug(districtName: string): string {
    return districtName
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
}

/**
 * Fetch rental listings from Bezrealitky via SSR page scraping.
 * The site uses Next.js with Apollo; listing data is embedded in __NEXT_DATA__.
 * Results are cached with the same TTL as Sreality (6h).
 *
 * Rate-limited to 1 request per second to respect the site.
 */
export async function fetchBezrealitkyRentals(
    filters: AnalysisFilters,
    refresh = false
): Promise<BezrealitkyListing[]> {
    const keyParams = buildCacheKeyParams(filters);
    const key = cacheKey(keyParams);

    if (!refresh) {
        const cached = await getCached<BezrealitkyListing>(key, SREALITY_TTL);

        if (cached) {
            return cached.data;
        }
    }

    const slug = getBezrealitkySlug(filters.district.name);
    const allListings: BezrealitkyListing[] = [];
    let page = 1;
    let totalCount = Number.POSITIVE_INFINITY;

    while ((page - 1) * PER_PAGE < totalCount) {
        const url = `${BASE_URL}/${slug}?page=${page}`;

        const response = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
        });

        if (!response.ok) {
            if (response.status === 404) {
                break;
            }

            throw new Error(`Bezrealitky fetch error (page ${page}): ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        const nextData = extractNextData(html);

        if (!nextData) {
            break;
        }

        const pageListings = parseBezrealitkyNextData(nextData);
        allListings.push(...pageListings);

        // Extract total count from Apollo cache
        const cache = nextData.props?.pageProps?.apolloCache ?? {};
        const rootQuery = cache.ROOT_QUERY as Record<string, unknown> | undefined;

        if (rootQuery) {
            for (const [queryKey, queryVal] of Object.entries(rootQuery)) {
                if (queryKey.startsWith("listAdverts(") && queryVal && typeof queryVal === "object") {
                    const advertList = queryVal as { totalCount?: number };

                    if (advertList.totalCount !== undefined) {
                        totalCount = advertList.totalCount;
                    }
                }
            }
        }

        if (pageListings.length === 0) {
            break;
        }

        page++;

        // Rate limit: 1 req/sec
        if ((page - 1) * PER_PAGE < totalCount) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    // Filter by disposition client-side if specified
    const filtered = filters.disposition
        ? allListings.filter((l) => l.disposition === filters.disposition)
        : allListings;

    const entry: CacheEntry<BezrealitkyListing> = {
        fetchedAt: new Date().toISOString(),
        params: keyParams,
        count: filtered.length,
        data: filtered,
    };

    await setCache(key, entry);

    return filtered;
}
