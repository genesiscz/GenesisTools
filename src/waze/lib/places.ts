import { logger } from "@genesiscz/utils/logger";
import type { WazeClient } from "./client";
import { parseLatLon } from "./geo";
import type { LatLon, Place } from "./types";

const { log } = logger.scoped("waze-places");

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_USER_AGENT = "GenesisTools-waze/1.0 (place geocoder)";

/** OpenStreetMap Nominatim, the fallback geocoder (sends only the query text). */
export async function nominatimSearch(query: string, limit = 1): Promise<Place[]> {
    const url = new URL(NOMINATIM);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, {
        headers: { "user-agent": NOMINATIM_USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        throw new Error(`Nominatim answered HTTP ${response.status} for "${query}"`);
    }

    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) {
        return [];
    }

    return rows.flatMap((row: unknown): Place[] => {
        if (typeof row !== "object" || row === null || !("lat" in row) || !("lon" in row)) {
            return [];
        }

        const lat = Number(row.lat);
        const lon = Number(row.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return [];
        }

        const label = "display_name" in row && typeof row.display_name === "string" ? row.display_name : query;
        return [{ lat, lon, label, source: "nominatim" }];
    });
}

/**
 * A place from `lat,lon` or a name. Names go to Waze's own search first (through the open tab, so it ranks like the
 * live map), then to Nominatim when Waze finds nothing or fails.
 */
export async function resolvePlace(opts: { query: string; client?: WazeClient; near?: LatLon }): Promise<Place> {
    const coords = parseLatLon(opts.query);
    if (coords) {
        return { ...coords, label: `${coords.lat.toFixed(5)},${coords.lon.toFixed(5)}`, source: "coords" };
    }

    if (opts.client) {
        try {
            const [first] = await opts.client.autocomplete({ query: opts.query, near: opts.near });
            if (first) {
                log.debug({ query: opts.query, venueId: first.venueId }, "place from waze search");
                return {
                    lat: first.lat,
                    lon: first.lon,
                    label: first.address ? `${first.name}, ${first.address}` : first.name,
                    address: first.address,
                    venueId: first.venueId,
                    source: "waze",
                };
            }
        } catch (error) {
            log.debug({ error, query: opts.query }, "waze search failed");
            log.warn(
                `Waze search failed for "${opts.query}", trying OpenStreetMap: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`
            );
        }
    }

    const [place] = await nominatimSearch(opts.query);
    if (!place) {
        throw new Error(`No location found for "${opts.query}"`);
    }

    log.debug({ query: opts.query, lat: place.lat, lon: place.lon }, "place from nominatim");
    return place;
}
