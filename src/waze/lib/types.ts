/** A WGS84 point. Waze's own wire format is `{x: lon, y: lat}`; everything inside this tool uses this shape. */
export interface LatLon {
    lat: number;
    lon: number;
}

/** A latitude/longitude box, the georss query shape (`top` = north, `left` = west). */
export interface BBox {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

/** The categories a user filters by. One Waze alert can count as two (a mobile speed camera is police and camera). */
export const ALERT_CATEGORIES = ["police", "accident", "hazard", "jam", "closure", "camera", "other"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export function isAlertCategory(value: string): value is AlertCategory {
    return (ALERT_CATEGORIES as readonly string[]).includes(value);
}

/** One user report from the live map, normalised. */
export interface WazeAlert {
    id: string;
    category: AlertCategory;
    /** Raw Waze type (`POLICE`, `ACCIDENT`, `HAZARD`, `JAM`, `ROAD_CLOSED`, ...). */
    type: string;
    /** Raw Waze subtype, empty when Waze sends none. */
    subtype: string;
    lat: number;
    lon: number;
    street?: string;
    description?: string;
    /** Report time, epoch milliseconds. */
    publishedAt: number;
    thumbsUp: number;
    /**
     * Ids of other reports of the same type at the same spot, merged into this one. Waze files a closure once per
     * direction, with two ids and one position.
     */
    twinIds?: string[];
}

/** One traffic jam line from the live map, normalised. */
export interface WazeJam {
    id: string;
    /** Waze jam level 0 (free) to 5 (blocked). */
    level: number;
    street?: string;
    city?: string;
    lengthM: number;
    speedKmh: number;
    updatedAt: number;
    line: LatLon[];
}

export interface FeedStats {
    /** georss requests sent, including the ones a split repeated. */
    requests: number;
    /** Tiles whose answer was not split further (under the cap, or at the depth limit or request budget). */
    tiles: number;
    /** Tiles still at the 200-item cap at the depth limit or the request budget: their area may miss reports. */
    capped: number;
    /** Tiles whose request failed after the retry: their area is missing from the answer. */
    failed: number;
}

export interface Feed {
    alerts: WazeAlert[];
    jams: WazeJam[];
    stats: FeedStats;
    fetchedAt: number;
}

export type PlaceSource = "coords" | "waze" | "nominatim";

export interface Place extends LatLon {
    label: string;
    source: PlaceSource;
    /** The Waze venue id when the Waze search found it (`venues.…` or `googlePlaces.…`). */
    venueId?: string;
    address?: string;
}

export type RouteSource = "waze" | "osrm";

export interface RouteAlternative {
    source: RouteSource;
    name: string;
    distanceM: number;
    durationSec: number;
    isFastest: boolean;
    isToll: boolean;
    /** Waze's traffic label, e.g. "usual traffic". */
    trafficLabel?: string;
    /** True when the Waze request allowed every vignette and toll road (`debugParams.subscription`). */
    withVignette: boolean;
    coords: LatLon[];
}

export interface DepartureOption {
    /** Epoch milliseconds. */
    leaveAt: number;
    arriveAt: number;
    minutes: number;
}

/** An alert or jam placed on a route: how far along it is and how far off the line. */
export interface CorridorPosition {
    /** Distance from the start along the route, metres. */
    alongM: number;
    /** Distance from the route line, metres. */
    offsetM: number;
    /** Side of the route line in the driving direction (a hint: Waze snaps reports to the reported carriageway). */
    side: "left" | "right";
}

export interface CorridorAlert extends WazeAlert, CorridorPosition {}

export interface CorridorJam extends WazeJam, CorridorPosition {}
