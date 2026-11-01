import type { AlertCategory, LatLon, WazeAlert, WazeJam } from "./types";

/** georss answers alerts with `{x: lon, y: lat}`; `uuid` and `city` were removed on 2026-04-29. */
interface RawPoint {
    x?: unknown;
    y?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function point(value: unknown): LatLon | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const raw: RawPoint = value;
    const lat = num(raw.y);
    const lon = num(raw.x);
    return lat === undefined || lon === undefined ? undefined : { lat, lon };
}

const TYPE_CATEGORY: Record<string, AlertCategory> = {
    POLICE: "police",
    ACCIDENT: "accident",
    HAZARD: "hazard",
    WEATHERHAZARD: "hazard",
    JAM: "jam",
    ROAD_CLOSED: "closure",
    CAMERA: "camera",
    SPEED_CAMERA: "camera",
};

/** The category of a raw Waze type; an unknown type with a `ROAD_CLOSED_*` subtype still counts as a closure. */
export function categoryOf(type: string, subtype: string): AlertCategory {
    return TYPE_CATEGORY[type] ?? (subtype.startsWith("ROAD_CLOSED") ? "closure" : "other");
}

/** Every category an alert answers to: a police report with a mobile speed camera is `police` and `camera`. */
export function categoriesOf(alert: Pick<WazeAlert, "category" | "subtype">): AlertCategory[] {
    if (alert.subtype === "POLICE_WITH_MOBILE_CAMERA") {
        return ["police", "camera"];
    }

    return [alert.category];
}

export function matchesCategories(alert: Pick<WazeAlert, "category" | "subtype">, wanted: AlertCategory[]): boolean {
    if (wanted.length === 0) {
        return true;
    }

    return categoriesOf(alert).some((category) => wanted.includes(category));
}

/** One raw georss alert → a WazeAlert, or undefined when it has no id or no position. */
export function normalizeAlert(raw: unknown): WazeAlert | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }

    const id = text(raw.id) ?? text(raw.uuid);
    const location = point(raw.location);
    if (!id || !location) {
        return undefined;
    }

    const type = text(raw.type) ?? "UNKNOWN";
    const subtype = text(raw.subtype) ?? "";
    return {
        id,
        category: categoryOf(type, subtype),
        type,
        subtype,
        lat: location.lat,
        lon: location.lon,
        street: text(raw.street),
        description: text(raw.reportDescription),
        publishedAt: num(raw.pubMillis) ?? 0,
        thumbsUp: num(raw.nThumbsUp) ?? 0,
    };
}

/** One raw georss jam → a WazeJam. `speed` is metres per second on the wire. */
export function normalizeJam(raw: unknown): WazeJam | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }

    const id = num(raw.id) ?? text(raw.id) ?? text(raw.uuid);
    const line = Array.isArray(raw.line) ? raw.line.map(point).filter((p): p is LatLon => p !== undefined) : [];
    if (id === undefined || line.length === 0) {
        return undefined;
    }

    const speed = num(raw.speedKMH) ?? (num(raw.speed) ?? 0) * 3.6;
    return {
        id: String(id),
        level: num(raw.level) ?? 0,
        street: text(raw.street),
        city: text(raw.city),
        lengthM: num(raw.length) ?? 0,
        speedKmh: Math.round(speed * 10) / 10,
        updatedAt: num(raw.updateMillis) ?? num(raw.pubMillis) ?? 0,
        line,
    };
}

/** Keeps the first item per id: neighbouring tiles overlap, and the same report arrives from each. */
export function dedupeById<T extends { id: string }>(items: Iterable<T>): T[] {
    const seen = new Map<string, T>();
    for (const item of items) {
        if (!seen.has(item.id)) {
            seen.set(item.id, item);
        }
    }

    return [...seen.values()];
}

/** Merges reports of the same type and subtype at the same spot (to about a metre) into the first one. */
export function mergeTwins(alerts: WazeAlert[]): WazeAlert[] {
    const bySpot = new Map<string, WazeAlert>();
    for (const alert of alerts) {
        const key = `${alert.type}|${alert.subtype}|${alert.lat.toFixed(5)}|${alert.lon.toFixed(5)}`;
        const first = bySpot.get(key);
        if (first) {
            first.twinIds = [...(first.twinIds ?? []), alert.id];
            first.thumbsUp = Math.max(first.thumbsUp, alert.thumbsUp);
            continue;
        }

        bySpot.set(key, { ...alert });
    }

    return [...bySpot.values()];
}

const CATEGORY_LABEL: Record<AlertCategory, string> = {
    police: "Police",
    accident: "Accident",
    hazard: "Hazard",
    jam: "Jam report",
    closure: "Closure",
    camera: "Camera",
    other: "Other",
};

/** `Police (hiding)`, `Hazard (on road: pot hole)`, `Closure` — a short human label. */
export function alertLabel(alert: Pick<WazeAlert, "category" | "type" | "subtype" | "twinIds">): string {
    const twins = alert.twinIds?.length ? ` ×${alert.twinIds.length + 1}` : "";
    return `${baseLabel(alert)}${twins}`;
}

function baseLabel(alert: Pick<WazeAlert, "category" | "type" | "subtype">): string {
    const base =
        alert.category === "other" ? alert.type.replaceAll("_", " ").toLowerCase() : CATEGORY_LABEL[alert.category];
    if (!alert.subtype) {
        return base;
    }

    const detail = alert.subtype
        .replace(new RegExp(`^${alert.type}_?`), "")
        .replace(/^ON_ROAD_?/, "on road ")
        .replace(/^ON_SHOULDER_?/, "on shoulder ")
        .replace(/^WEATHER_?/, "weather ")
        .replaceAll("_", " ")
        .trim()
        .toLowerCase();
    return detail ? `${base} (${detail})` : base;
}

/** `3 min`, `2 h 5 min`, `1 d 4 h` — the age of a report relative to `now`. */
export function formatAge(publishedAt: number, now: number): string {
    if (!publishedAt) {
        return "?";
    }

    const minutes = Math.max(0, Math.round((now - publishedAt) / 60_000));
    if (minutes < 60) {
        return `${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        const rest = minutes % 60;
        return rest ? `${hours} h ${rest} min` : `${hours} h`;
    }

    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days} d ${restHours} h` : `${days} d`;
}
