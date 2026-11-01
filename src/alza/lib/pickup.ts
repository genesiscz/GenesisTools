import { logger } from "@genesiscz/utils/logger";
import type { AlzaApi } from "./api";
import type { PickupPlace } from "./types";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "GenesisTools-alza/1.0 (postal-code geocoder)";

export interface GeoPoint {
    latitude: number;
    longitude: number;
    label?: string;
}

/** A postal code or a place name to coordinates through OpenStreetMap Nominatim (sends only the query text). */
export async function geocode(query: string, countryCode: string): Promise<GeoPoint> {
    const url = new URL(NOMINATIM);
    const compact = query.replace(/\s+/g, "");
    if (/^\d{5}$/.test(compact)) {
        url.searchParams.set("postalcode", `${compact.slice(0, 3)} ${compact.slice(3)}`);
    } else {
        url.searchParams.set("q", query);
    }

    url.searchParams.set("countrycodes", countryCode);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
    if (!response.ok) {
        throw new Error(`Nominatim answered HTTP ${response.status} for ${query}`);
    }

    const rows: unknown = await response.json();
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
