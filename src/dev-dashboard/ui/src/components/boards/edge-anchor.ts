// Pure geometry for EdgeLayer's connect-tool wires — port of vitrinka's edgeAnchors/cardSides
// (board-1.mjs:485-517): a wire always leaves/enters the CLOSEST face of each card, not a fixed
// side, so it reads naturally regardless of relative card position.
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Point {
    x: number;
    y: number;
}

/** The four side-midpoints of a card's bounds: [top, bottom, left, right]. */
export function cardSides(r: Rect): Point[] {
    return [
        { x: r.x + r.w / 2, y: r.y },
        { x: r.x + r.w / 2, y: r.y + r.h },
        { x: r.x, y: r.y + r.h / 2 },
        { x: r.x + r.w, y: r.y + r.h / 2 },
    ];
}

export function dist(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The pair of side-midpoints (one per rect) minimizing distance between them. */
export function nearestSidePair(a: Rect, b: Rect): [Point, Point] {
    let best: [Point, Point] = [cardSides(a)[3], cardSides(b)[2]];
    let bestDist = Number.POSITIVE_INFINITY;

    for (const pa of cardSides(a)) {
        for (const pb of cardSides(b)) {
            const d = dist(pa, pb);
            if (d < bestDist) {
                bestDist = d;
                best = [pa, pb];
            }
        }
    }

    return best;
}

/** The side-midpoint of a rect nearest a fixed point (for point-anchored edges). */
export function nearestSideToPoint(r: Rect, p: Point): Point {
    return cardSides(r).reduce((best, side) => (dist(side, p) < dist(best, p) ? side : best));
}
