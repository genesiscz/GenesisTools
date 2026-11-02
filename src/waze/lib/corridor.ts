import { matchesCategories } from "./alerts";
import type { FeedType, WazeClient } from "./client";
import { corridorTiles, cumulativeDistances, haversineM, positionOnLine } from "./geo";
import type {
    AlertCategory,
    CorridorAlert,
    CorridorJam,
    CorridorPosition,
    FeedStats,
    LatLon,
    WazeAlert,
    WazeJam,
} from "./types";

export const DEFAULT_CORRIDOR_M = 150;
/** Route length per georss tile before padding. A capped tile is still split by the client. */
export const DEFAULT_TILE_M = 30_000;

/**
 * Keeps the alerts within `maxOffsetM` of the line and places each one on it (metres along, metres off, side), ordered
 * from the start.
 */
export function alertsOnLine(opts: {
    alerts: WazeAlert[];
    line: LatLon[];
    maxOffsetM: number;
    cumulative?: number[];
}): CorridorAlert[] {
    const cumulative = opts.cumulative ?? cumulativeDistances(opts.line);
    return opts.alerts
        .map((alert) => ({ ...alert, ...positionOnLine(alert, opts.line, cumulative) }))
        .filter((alert) => alert.offsetM <= opts.maxOffsetM)
        .sort((a, b) => a.alongM - b.alongM);
}

/** A jam line lies on a Waze route's own segments, so its points sit within a few metres of the route line. */
export const JAM_MAX_OFFSET_M = 40;
/** How much of a jam's own length must advance along the route: below this it crosses or runs the other way. */
const JAM_MIN_ALIGNMENT = 0.6;

/**
 * Keeps the jams that run along the line in the driving direction: at least two of their points lie within
 * `maxOffsetM`, and between the first and the last of those the jam advances along the route by at least 60% of its
 * own length. That drops crossing streets, slip roads and the opposite carriageway. Each jam is placed at its first
 * near point.
 */
export function jamsOnLine(opts: {
    jams: WazeJam[];
    line: LatLon[];
    maxOffsetM: number;
    cumulative?: number[];
}): CorridorJam[] {
    const cumulative = opts.cumulative ?? cumulativeDistances(opts.line);
    const out: CorridorJam[] = [];
    for (const jam of opts.jams) {
        const near: Array<CorridorPosition & { point: LatLon }> = [];
        for (const point of jam.line) {
            const position = positionOnLine(point, opts.line, cumulative);
            if (position.offsetM <= opts.maxOffsetM) {
                near.push({ ...position, point });
            }
        }

        const first = near[0];
        const last = near.at(-1);
        if (!first || !last || near.length < 2) {
            continue;
        }

        const ownLength = haversineM(first.point, last.point);
        if (ownLength > 0 && (last.alongM - first.alongM) / ownLength < JAM_MIN_ALIGNMENT) {
            continue;
        }

        out.push({ ...jam, alongM: first.alongM, offsetM: first.offsetM, side: first.side });
    }

    return out.sort((a, b) => a.alongM - b.alongM);
}

export interface CorridorResult {
    alerts: CorridorAlert[];
    jams: CorridorJam[];
    lengthM: number;
    stats: FeedStats & { tilesPlanned: number };
    fetchedAt: number;
}

/** Fetches the tiles along a route and returns the alerts and jams on its corridor, ordered from the start. */
export async function scanCorridor(opts: {
    client: WazeClient;
    line: LatLon[];
    corridorM?: number;
    tileM?: number;
    types?: AlertCategory[];
    feedTypes?: FeedType[];
}): Promise<CorridorResult> {
    const corridorM = opts.corridorM ?? DEFAULT_CORRIDOR_M;
    const boxes = corridorTiles({ line: opts.line, tileM: opts.tileM ?? DEFAULT_TILE_M, paddingM: corridorM + 50 });
    const feed = await opts.client.feed({ boxes, types: opts.feedTypes });
    const cumulative = cumulativeDistances(opts.line);
    const wanted = opts.types ?? [];
    return {
        alerts: alertsOnLine({
            alerts: feed.alerts.filter((alert) => matchesCategories(alert, wanted)),
            line: opts.line,
            maxOffsetM: corridorM,
            cumulative,
        }),
        jams: jamsOnLine({
            jams: feed.jams,
            line: opts.line,
            maxOffsetM: Math.min(corridorM, JAM_MAX_OFFSET_M),
            cumulative,
        }),
        lengthM: cumulative.at(-1) ?? 0,
        stats: { ...feed.stats, tilesPlanned: boxes.length },
        fetchedAt: feed.fetchedAt,
    };
}

/** Alerts within `radiusM` of a center, nearest first, with their distance. */
export function alertsNear(opts: {
    alerts: WazeAlert[];
    center: LatLon;
    radiusM: number;
}): Array<WazeAlert & { distanceM: number }> {
    return opts.alerts
        .map((alert) => ({ ...alert, distanceM: haversineM(opts.center, alert) }))
        .filter((alert) => alert.distanceM <= opts.radiusM)
        .sort((a, b) => a.distanceM - b.distanceM);
}

/** Jams with at least one point within `radiusM` of a center, nearest first. */
export function jamsNear(opts: {
    jams: WazeJam[];
    center: LatLon;
    radiusM: number;
}): Array<WazeJam & { distanceM: number }> {
    return opts.jams
        .map((jam) => ({ ...jam, distanceM: Math.min(...jam.line.map((point) => haversineM(opts.center, point))) }))
        .filter((jam) => jam.distanceM <= opts.radiusM)
        .sort((a, b) => a.distanceM - b.distanceM);
}
