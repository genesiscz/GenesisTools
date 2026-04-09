import { BezrealitkyClient, mapBezrealitkyDisposition } from "@app/Internal/commands/reas/api/BezrealitkyClient";
import type { BezrealitkyAdvertDetail } from "@app/Internal/commands/reas/api/BezrealitkyClient.types";
import type { AnalysisFilters, RentalListing, SaleListing } from "@app/Internal/commands/reas/types";
import { SafeJSON } from "@app/utils/json";

const client = new BezrealitkyClient();

export { BezrealitkyClient, mapBezrealitkyDisposition } from "@app/Internal/commands/reas/api/BezrealitkyClient";
export type { BezrealitkyAdvertDetail } from "@app/Internal/commands/reas/api/BezrealitkyClient.types";

/**
 * Deprecated internal region ids from the old SSR-based implementation.
 * The GraphQL client now resolves `regionOsmIds` through autocomplete.
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

interface BzrAdvertRaw {
    id: string;
    uri: string;
    disposition: string;
    surface?: number;
    price?: number;
    charges?: number;
    reserved?: boolean;
    gps?: { lat?: number; lng?: number };
    [key: string]: unknown;
}

interface BzrNextData {
    props?: {
        pageProps?: {
            apolloCache?: Record<string, unknown>;
        };
    };
}

export function parseBezrealitkyNextData(nextData: BzrNextData): BezrealitkyListing[] {
    const cache = nextData.props?.pageProps?.apolloCache;

    if (!cache) {
        return [];
    }

    const listings: BezrealitkyListing[] = [];

    for (const [key, value] of Object.entries(cache)) {
        if (!key.startsWith("Advert:")) {
            continue;
        }

        if (!value || typeof value !== "object") {
            continue;
        }

        const advert = value as BzrAdvertRaw;

        if (advert.reserved) {
            continue;
        }

        const addressKey = Object.keys(advert).find((candidate) => candidate.startsWith("address("));
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

export function extractNextData(html: string): BzrNextData | null {
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

export async function fetchBezrealitkyRentals(filters: AnalysisFilters, refresh = false): Promise<RentalListing[]> {
    return client.fetchRentalListings(filters, refresh);
}

export async function fetchBezrealitkySales(filters: AnalysisFilters, refresh = false): Promise<SaleListing[]> {
    return client.fetchSaleListings(filters, refresh);
}

export async function fetchBezrealitkyAdvertDetail(advertIdOrUri: string): Promise<BezrealitkyAdvertDetail> {
    return client.fetchAdvertDetail(advertIdOrUri);
}
