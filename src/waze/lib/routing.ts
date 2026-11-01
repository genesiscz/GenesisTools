import { logger } from "@genesiscz/utils/logger";
import type { WazeClient } from "./client";
import type { DepartureOption, LatLon, RouteAlternative } from "./types";

const { log } = logger.scoped("waze-routing");

const OSRM = "https://router.project-osrm.org/route/v1/driving";

/** The public OSRM demo server: a fallback so a corridor exists when Waze routing fails. No traffic, no Waze data. */
export async function osrmRoute(from: LatLon, to: LatLon, alternatives = false): Promise<RouteAlternative[]> {
    const url = new URL(`${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}`);
    url.searchParams.set("overview", "full");
    url.searchParams.set("geometries", "geojson");
    url.searchParams.set("alternatives", alternatives ? "true" : "false");
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
        throw new Error(`OSRM answered HTTP ${response.status}`);
    }

    const data: unknown = await response.json();
    const routes =
        typeof data === "object" && data !== null && "routes" in data && Array.isArray(data.routes) ? data.routes : [];
    return routes.flatMap((route: unknown, index: number): RouteAlternative[] => {
        if (typeof route !== "object" || route === null || !("geometry" in route)) {
            return [];
        }

        const geometry = route.geometry;
        const coordinates =
            typeof geometry === "object" &&
            geometry !== null &&
            "coordinates" in geometry &&
            Array.isArray(geometry.coordinates)
                ? geometry.coordinates
                : [];
        const coords = coordinates.flatMap((pair: unknown): LatLon[] =>
            Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number"
                ? [{ lat: pair[1], lon: pair[0] }]
                : []
        );
        const distance = "distance" in route && typeof route.distance === "number" ? route.distance : 0;
        const duration = "duration" in route && typeof route.duration === "number" ? route.duration : 0;
        return [
            {
                source: "osrm",
                name: `OSRM ${index + 1}`,
                distanceM: distance,
                durationSec: duration,
                isFastest: index === 0,
                isToll: false,
                withVignette: true,
                coords,
            },
        ];
    });
}

export interface PlannedRoute {
    routes: RouteAlternative[];
    departures: DepartureOption[];
    /** Set when Waze failed and OSRM answered instead. */
    fallbackReason?: string;
}

/**
 * Routes for a trip. Waze first: with `vignette` one fastest path that may use vignette motorways; with
 * `alternatives` also the no-vignette paths Waze offers. When Waze fails, OSRM answers (labelled `osrm`).
 */
export async function planRoute(opts: {
    client: WazeClient;
    from: LatLon;
    to: LatLon;
    vignette: boolean;
    alternatives: boolean;
    startTime?: number;
}): Promise<PlannedRoute> {
    try {
        const primary = await opts.client.userDrive({
            from: opts.from,
            to: opts.to,
            withVignette: opts.vignette,
            paths: 3,
            startTime: opts.startTime,
        });
        const routes = [...primary.routes];
        if (opts.vignette && opts.alternatives) {
            const extra = await opts.client.userDrive({ from: opts.from, to: opts.to, withVignette: false, paths: 3 });
            routes.push(...extra.routes.filter((route) => !routes.some((known) => known.name === route.name)));
        }

        if (routes.length === 0) {
            throw new Error("Waze returned no route");
        }

        return { routes, departures: primary.departures };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.warn({ error }, "waze routing failed, falling back to OSRM");
        const routes = await osrmRoute(opts.from, opts.to, opts.alternatives);
        if (routes.length === 0) {
            throw new Error(`Neither Waze (${reason}) nor OSRM found a route`);
        }

        return { routes, departures: [], fallbackReason: reason };
    }
}
