import { logger } from "@genesiscz/utils/logger";
import type { AlzaApi } from "./api";
import type { PickupPlace } from "./types";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "GenesisTools-alza/1.0 (postal-code geocoder)";
/** The whole lookup, body included. */
const GEOCODE_TIMEOUT_MS = 15_000;
/** Countries whose 5-digit postal codes are written "NNN NN", the form Nominatim matches for them. */
const SPACED_POSTAL_CODES = new Set(["cz", "sk"]);

export interface GeoPoint {
    latitude: number;
    longitude: number;
    label?: string;
}

/** The Nominatim search for a postal code (a 5-digit one spaced as "NNN NN" in CZ and SK only) or a place name. */
export function geocodeUrl(query: string, countryCode: string): URL {
    const url = new URL(NOMINATIM);
    const compact = query.replace(/\s+/g, "");
    if (/^\d{5}$/.test(compact)) {
        const spaced = SPACED_POSTAL_CODES.has(countryCode.toLowerCase());
        url.searchParams.set("postalcode", spaced ? `${compact.slice(0, 3)} ${compact.slice(3)}` : compact);
    } else {
        url.searchParams.set("q", query);
    }

    url.searchParams.set("countrycodes", countryCode);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    return url;
}

/** The rows of one Nominatim search, read within GEOCODE_TIMEOUT_MS (the signal also ends a stalled body). */
async function nominatimRows(url: URL, query: string): Promise<unknown> {
    try {
        const response = await fetch(url, {
            headers: { "user-agent": USER_AGENT, accept: "application/json" },
            signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`Nominatim answered HTTP ${response.status} for ${query}`);
        }

        return await response.json();
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            throw new Error(`Nominatim did not answer within ${GEOCODE_TIMEOUT_MS / 1000} s for "${query}"; try again`);
        }

        throw error;
    }
}

/** A postal code or a place name to coordinates through OpenStreetMap Nominatim (sends only the query text). */
export async function geocode(query: string, countryCode: string): Promise<GeoPoint> {
    const rows = await nominatimRows(geocodeUrl(query, countryCode), query);
    const first = Array.isArray(rows) ? rows[0] : undefined;
    const latitude = Number(first?.lat);
    const longitude = Number(first?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error(`No location found for "${query}"`);
    }

    logger.debug({ query, latitude, longitude }, "geocoded");
    return { latitude, longitude, label: typeof first?.display_name === "string" ? first.display_name : undefined };
}

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** AlzaBox lockers nearest to a postal code, a place name or `lat,lon`. */
export async function findPickupPoints(
    api: AlzaApi,
    opts: { near: string; limit?: number }
): Promise<{ center: GeoPoint; places: PickupPlace[] }> {
    const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(opts.near);
    const center = coords
        ? { latitude: Number(coords[1]), longitude: Number(coords[2]) }
        : await geocode(opts.near, api.storefront.geoCountry);
    const response = await api.places({
        latitude: center.latitude,
        longitude: center.longitude,
        limit: opts.limit ?? 10,
    });
    const places = (response.pickupPlaces?.value ?? []).map((p) => {
        const point = p.gpsPosition
            ? { latitude: p.gpsPosition.latitude, longitude: p.gpsPosition.longitude }
            : undefined;
        return {
            id: p.id,
            kind: p.typeText ?? p.title ?? "AlzaBox",
            name: p.name ?? p.title ?? p.id,
            address: p.addressText ?? undefined,
            latitude: point?.latitude,
            longitude: point?.longitude,
            distanceKm: point ? Math.round(distanceKm(center, point) * 100) / 100 : undefined,
        };
    });
    return { center, places };
}
