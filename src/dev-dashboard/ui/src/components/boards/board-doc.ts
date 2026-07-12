import type { BoardDocDto, CardDto, EdgeDto, StrokeDto } from "@app/dev-dashboard/contract/dto";

/** Pure immutable helpers over the board doc — vitrinka's `upsert`/`mergeEvent` idiom
 *  (board-1.mjs:458-568) adapted to our react-query cache: mutations fold the server's
 *  returned row back into the cached doc instead of waiting for a refetch. */

function upsertById<T extends { id: number }>(list: T[], item: T): T[] {
    const idx = list.findIndex((v) => v.id === item.id);

    if (idx === -1) {
        return [...list, item];
    }

    const next = [...list];
    next[idx] = item;
    return next;
}

export function upsertCard(doc: BoardDocDto, card: CardDto): BoardDocDto {
    return { ...doc, cards: upsertById(doc.cards, card) };
}

export function patchCardIn(doc: BoardDocDto, id: number, patch: Partial<CardDto>): BoardDocDto {
    return {
        ...doc,
        cards: doc.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    };
}

/** Remove a card and cascade to everything referencing it (vitrinka card_deleted, board-1.mjs:471-478). */
export function removeCard(doc: BoardDocDto, id: number): BoardDocDto {
    return {
        ...doc,
        cards: doc.cards.filter((c) => c.id !== id),
        edges: doc.edges.filter((e) => e.fromCard !== id && e.toCard !== id),
        strokes: doc.strokes.filter((s) => s.cardId !== id),
        annotations: doc.annotations.filter((a) => a.cardId !== id),
    };
}

export function upsertStroke(doc: BoardDocDto, stroke: StrokeDto): BoardDocDto {
    return { ...doc, strokes: upsertById(doc.strokes, stroke) };
}

export function removeStroke(doc: BoardDocDto, id: number): BoardDocDto {
    return { ...doc, strokes: doc.strokes.filter((s) => s.id !== id) };
}

/** Swap a temp (negative-id) stroke for the server row — vitrinka commitStroke (board-1.mjs:6572-6582). */
export function swapStroke(doc: BoardDocDto, tempId: number, stroke: StrokeDto): BoardDocDto {
    return {
        ...doc,
        strokes: upsertById(
            doc.strokes.filter((s) => s.id !== tempId),
            stroke
        ),
    };
}

export function upsertEdge(doc: BoardDocDto, edge: EdgeDto): BoardDocDto {
    return { ...doc, edges: upsertById(doc.edges, edge) };
}

export function removeEdge(doc: BoardDocDto, id: number): BoardDocDto {
    return { ...doc, edges: doc.edges.filter((e) => e.id !== id) };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Geom {
    x: number;
    y: number;
    w: number;
    h: number;
}

export const MIN_CARD_SIZE = 40;

/** Resize-by-corner math — port of vitrinka resizeGeom (board-1.mjs:381-396). `corner` is one of
 *  nw/ne/sw/se/n/e/s/w; `w`/`n` edges also shift x/y. Aspect lock derives the smaller delta. */
export function resizeGeom(orig: Geom, corner: string, dx: number, dy: number, lockAspect: boolean): Geom {
    let { x, y, w, h } = orig;

    if (corner.includes("e")) {
        w = Math.max(MIN_CARD_SIZE, orig.w + dx);
    }

    if (corner.includes("s")) {
        h = Math.max(MIN_CARD_SIZE, orig.h + dy);
    }

    if (corner.includes("w")) {
        w = Math.max(MIN_CARD_SIZE, orig.w - dx);
        x = orig.x + orig.w - w;
    }

    if (corner.includes("n")) {
        h = Math.max(MIN_CARD_SIZE, orig.h - dy);
        y = orig.y + orig.h - h;
    }

    if (lockAspect && orig.w > 0 && orig.h > 0) {
        const ratio = orig.w / orig.h;

        if (Math.abs(w - orig.w) >= Math.abs(h - orig.h) * ratio) {
            h = Math.max(MIN_CARD_SIZE, w / ratio);
        } else {
            w = Math.max(MIN_CARD_SIZE, h * ratio);
        }

        if (corner.includes("w")) {
            x = orig.x + orig.w - w;
        }

        if (corner.includes("n")) {
            y = orig.y + orig.h - h;
        }
    }

    return { x, y, w, h };
}

/** Cards whose center sits inside the section frame (vitrinka spatial membership,
 *  board-1.mjs:146-165). Nested sections join only when strictly smaller in area. */
export function sectionMemberIds(cards: CardDto[], section: CardDto): number[] {
    const area = section.w * section.h;

    return cards
        .filter((c) => {
            if (c.id === section.id) {
                return false;
            }

            if (c.kind === "section" && c.w * c.h >= area) {
                return false;
            }

            const cx = c.x + c.w / 2;
            const cy = c.y + c.h / 2;
            return cx >= section.x && cx <= section.x + section.w && cy >= section.y && cy <= section.y + section.h;
        })
        .map((c) => c.id);
}

// ---------------------------------------------------------------------------
// Ink shape recognition — port of vitrinka recognizeShape (board-1.mjs:407-452).
// Thresholds are screen px divided by scale so behavior is zoom-invariant.
// ---------------------------------------------------------------------------

type Pt = number[];

function pathLength(points: Pt[]): number {
    let len = 0;

    for (let i = 1; i < points.length; i++) {
        len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }

    return len;
}

function perpDistance(p: Pt, a: Pt, b: Pt): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        return Math.hypot(p[0] - a[0], p[1] - a[1]);
    }

    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker simplification. */
export function rdp(points: Pt[], epsilon: number): Pt[] {
    if (points.length < 3) {
        return points;
    }

    let maxDist = 0;
    let maxIdx = 0;

    for (let i = 1; i < points.length - 1; i++) {
        const d = perpDistance(points[i], points[0], points[points.length - 1]);

        if (d > maxDist) {
            maxDist = d;
            maxIdx = i;
        }
    }

    if (maxDist <= epsilon) {
        return [points[0], points[points.length - 1]];
    }

    const left = rdp(points.slice(0, maxIdx + 1), epsilon);
    const right = rdp(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
}

export interface RecognizedShape {
    kind: "line" | "ellipse" | "rect";
    bounds: Geom;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
}

/** Classify a finished stroke as line / ellipse / rect, or null to keep raw ink. */
export function recognizeShape(points: Pt[], scale: number): RecognizedShape | null {
    if (points.length < 3) {
        return null;
    }

    const len = pathLength(points);

    if (len < 60 / scale) {
        return null;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const gap = Math.hypot(last[0] - first[0], last[1] - first[1]);

    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const bounds: Geom = {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
    };

    // Line: endpoints far apart and every point hugs the chord.
    if (gap > 0.5 * len) {
        const maxDev = Math.max(...points.map((p) => perpDistance(p, first, last)));

        if (maxDev < 12 / scale) {
            return {
                kind: "line",
                bounds,
                start: { x: first[0], y: first[1] },
                end: { x: last[0], y: last[1] },
            };
        }
    }

    // Open scribble: not closed enough for ellipse/rect.
    if (gap > 0.25 * len) {
        return null;
    }

    // Ellipse: steady centroid radius.
    const cx = xs.reduce((a, b) => a + b, 0) / points.length;
    const cy = ys.reduce((a, b) => a + b, 0) / points.length;
    const radii = points.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    const dev = Math.sqrt(radii.reduce((a, r) => a + (r - mean) ** 2, 0) / radii.length);

    if (mean > 0 && dev / mean < 0.16) {
        return { kind: "ellipse", bounds };
    }

    // Rect: RDP simplifies to 3-6 corners.
    const simplified = rdp(points, 14 / scale);

    if (simplified.length >= 3 && simplified.length <= 7) {
        return { kind: "rect", bounds };
    }

    return null;
}

/** Translate a stroke path by (dx, dy). */
export function translatePath(path: number[][], dx: number, dy: number): number[][] {
    return path.map(([x, y, ...rest]) => [x + dx, y + dy, ...rest]);
}
