import type { BBox, CorridorPosition, LatLon } from "./types";

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineM(a: LatLon, b: LatLon): number {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `50.08,14.43` or `50.08 14.43` → a point; anything else → undefined. */
export function parseLatLon(text: string): LatLon | undefined {
    const match = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) {
        return undefined;
    }

    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return undefined;
    }

    return { lat, lon };
}

/** `south,west,north,east` (four numbers) → a box; anything else → undefined. */
export function parseBBox(text: string): BBox | undefined {
    const parts = text.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
        return undefined;
    }

    const [south, west, north, east] = parts as [number, number, number, number];
    if (south >= north || west >= east || Math.abs(south) > 90 || Math.abs(north) > 90) {
        return undefined;
    }

    return { top: north, bottom: south, left: west, right: east };
}

export function bboxAround(center: LatLon, radiusM: number): BBox {
    const dLat = radiusM / 111_320;
    const dLon = radiusM / (111_320 * Math.max(0.01, Math.cos(rad(center.lat))));
    return { top: center.lat + dLat, bottom: center.lat - dLat, left: center.lon - dLon, right: center.lon + dLon };
}

export function bboxCenter(box: BBox): LatLon {
    return { lat: (box.top + box.bottom) / 2, lon: (box.left + box.right) / 2 };
}

export function bboxContains(box: BBox, point: LatLon): boolean {
    return point.lat <= box.top && point.lat >= box.bottom && point.lon >= box.left && point.lon <= box.right;
}

/** The box of a set of points, grown by `paddingM` on every side. */
export function bboxOf(points: LatLon[], paddingM = 0): BBox {
    if (points.length === 0) {
        throw new Error("bboxOf needs at least one point");
    }

    let top = -90;
    let bottom = 90;
    let left = 180;
    let right = -180;
    for (const point of points) {
        top = Math.max(top, point.lat);
        bottom = Math.min(bottom, point.lat);
        left = Math.min(left, point.lon);
        right = Math.max(right, point.lon);
    }

    const dLat = paddingM / 111_320;
    const dLon = paddingM / (111_320 * Math.max(0.01, Math.cos(rad((top + bottom) / 2))));
    return { top: top + dLat, bottom: bottom - dLat, left: left - dLon, right: right + dLon };
}

/** The four quarters of a box, used when one georss answer hits the item cap. */
export function splitBBox(box: BBox): BBox[] {
    const { lat, lon } = bboxCenter(box);
    return [
        { top: box.top, bottom: lat, left: box.left, right: lon },
        { top: box.top, bottom: lat, left: lon, right: box.right },
        { top: lat, bottom: box.bottom, left: box.left, right: lon },
        { top: lat, bottom: box.bottom, left: lon, right: box.right },
    ];
}

/** Cumulative distance from the first point, metres, one entry per point. */
export function cumulativeDistances(line: LatLon[]): number[] {
    const out: number[] = [];
    let total = 0;
    for (let i = 0; i < line.length; i++) {
        if (i > 0) {
            total += haversineM(line[i - 1] as LatLon, line[i] as LatLon);
        }

        out.push(total);
    }

    return out;
}

/**
 * Tiles that cover a route corridor: the line is cut into pieces about `tileM` long, and each piece's box is grown by
 * `paddingM`. Short pieces keep each tile's georss answer under the item cap on a busy road.
 */
export function corridorTiles(opts: { line: LatLon[]; tileM: number; paddingM: number }): BBox[] {
    const { line, tileM, paddingM } = opts;
    if (line.length === 0) {
        return [];
    }

    const tiles: BBox[] = [];
    let piece: LatLon[] = [line[0] as LatLon];
    let pieceLength = 0;
    for (let i = 1; i < line.length; i++) {
        const point = line[i] as LatLon;
        pieceLength += haversineM(line[i - 1] as LatLon, point);
        piece.push(point);
        if (pieceLength >= tileM) {
            tiles.push(bboxOf(piece, paddingM));
            piece = [point];
            pieceLength = 0;
        }
    }

    if (piece.length > 1 || tiles.length === 0) {
        tiles.push(bboxOf(piece, paddingM));
    }

    return tiles;
}

interface Projection {
    distanceM: number;
    /** Fraction along the segment, 0..1. */
    t: number;
    /** Positive when the point is left of the segment direction. */
    cross: number;
}

/** Point to segment on a local flat projection around `p`; accurate to a few metres over a few kilometres. */
function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): Projection {
    const kx = 111_320 * Math.cos(rad(p.lat));
    const ky = 110_540;
    const ax = (a.lon - p.lon) * kx;
    const ay = (a.lat - p.lat) * ky;
    const bx = (b.lon - p.lon) * kx;
    const by = (b.lat - p.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    // Cross product of the segment direction with the vector to p (p is the origin, so the vector is -a).
    const cross = dx * -ay - dy * -ax;
    return { distanceM: Math.hypot(cx, cy), t, cross };
}

/**
 * Where a point sits relative to a route: metres along the route to its nearest spot, metres off the line, and the
 * side. `cumulative` is `cumulativeDistances(line)`, passed in so a caller placing many points computes it once.
 */
export function positionOnLine(point: LatLon, line: LatLon[], cumulative: number[]): CorridorPosition {
    if (line.length === 1) {
        return { alongM: 0, offsetM: haversineM(point, line[0] as LatLon), side: "right" };
    }

    let best: CorridorPosition = { alongM: 0, offsetM: Number.POSITIVE_INFINITY, side: "right" };
    for (let i = 1; i < line.length; i++) {
        const a = line[i - 1] as LatLon;
        const b = line[i] as LatLon;
        const projection = projectOnSegment(point, a, b);
        if (projection.distanceM < best.offsetM) {
            const start = cumulative[i - 1] ?? 0;
            const end = cumulative[i] ?? start;
            best = {
                alongM: start + projection.t * (end - start),
                offsetM: projection.distanceM,
                side: projection.cross > 0 ? "left" : "right",
            };
        }
    }

    return best;
}

/**
 * Waze serves three geo environments; a request with the wrong one answers empty. North America is `na`, Israel `il`,
 * everything else `row` (the live-map bundle's `findGeoEnv` draws the same lines).
 */
export function geoEnvFor(point: LatLon): "row" | "na" | "il" {
    if (point.lat >= 29.4 && point.lat <= 33.4 && point.lon >= 34.2 && point.lon <= 35.9) {
        return "il";
    }

    if (point.lon <= -50 && point.lon >= -170 && point.lat >= 5) {
        return "na";
    }

    return "row";
}

/** Thin a polyline to at most `max` points, always keeping the first and the last (for exports and MCP answers). */
export function thinLine(line: LatLon[], max: number): LatLon[] {
    if (line.length <= max || max < 2) {
        return line;
    }

    const step = (line.length - 1) / (max - 1);
    const out: LatLon[] = [];
    for (let i = 0; i < max; i++) {
        out.push(line[Math.round(i * step)] as LatLon);
    }

    return out;
}
