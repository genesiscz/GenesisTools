/**
 * Where a shape's label goes. Pure arithmetic, no canvas and no DOM, so the canvas renderer (render-plan.ts) and the
 * web overlay of annotated page shots place labels the same way.
 *
 * A label tries its requested position first, then the others (`fallbackOrder`). A spot fits when it lies inside the
 * bounds (the image, or a shot's clip) and covers no obstacle (labels placed before it, and on a web page the page's
 * own text). The first spot that fits wins. When none fits, the caller decides: the canvas renderer draws the
 * requested spot clamped into the image and warns, a web shot fails and names the label.
 */
import type { AnnotationPoint, AnnotationRect, LabelPosition } from "./annotation-plan";

export interface LabelSize {
    w: number;
    h: number;
}

/** How far a `left` or `right` label stands off its shape when a leader line joins them. */
export const LEADER_REACH = 36;
/** Where an `inside` label sits from the shape's top-left corner. */
export const INSIDE_INSET: AnnotationPoint = { x: 10, y: 8 };

const OPPOSITE: Record<LabelPosition, LabelPosition> = {
    "top-left": "bottom-left",
    "top-right": "bottom-right",
    top: "bottom",
    "bottom-left": "top-left",
    "bottom-right": "top-right",
    bottom: "top",
    left: "right",
    right: "left",
    inside: "inside",
};

/** After the requested position and its opposite: the sides, then the other alignments, and inside last. */
const PREFERENCE: readonly LabelPosition[] = [
    "right",
    "left",
    "bottom-left",
    "top-left",
    "bottom-right",
    "top-right",
    "bottom",
    "top",
    "inside",
];

export interface LabelRequest {
    /** The shape the label belongs to, in the bounds' pixels. */
    rect: AnnotationRect;
    size: LabelSize;
    position: LabelPosition;
    /** Space between the shape and an outside label above or below it. */
    gap: number;
    offset?: AnnotationPoint;
    /** A line joins a `left` or `right` label to its shape. Default true for those two. */
    leader?: boolean;
}

export interface PlacedLabel {
    chip: AnnotationRect;
    position: LabelPosition;
    /** The requested position did not fit, so another one was taken. */
    moved: boolean;
    leader?: { from: AnnotationPoint; to: AnnotationPoint };
}

export type LabelPlacement = { ok: true; label: PlacedLabel } | { ok: false; tried: LabelPosition[] };

export function fallbackOrder(position: LabelPosition): LabelPosition[] {
    return [...new Set<LabelPosition>([position, OPPOSITE[position], ...PREFERENCE])];
}

function hasLeader(request: LabelRequest, position: LabelPosition): boolean {
    return (position === "left" || position === "right") && request.leader !== false;
}

/** The chip's rectangle at one position, offset included. */
export function labelSpot(request: LabelRequest, position: LabelPosition): AnnotationRect {
    const { rect, size, gap } = request;
    const reach = hasLeader(request, position) ? LEADER_REACH : gap;
    const above = rect.y - size.h - gap;
    const below = rect.y + rect.h + gap;
    const middle = rect.y + Math.max(0, (rect.h - size.h) / 2);
    const centered = rect.x + (rect.w - size.w) / 2;
    const spots: Record<LabelPosition, AnnotationPoint> = {
        "top-left": { x: rect.x, y: above },
        "top-right": { x: rect.x + rect.w - size.w, y: above },
        top: { x: centered, y: above },
        "bottom-left": { x: rect.x, y: below },
        "bottom-right": { x: rect.x + rect.w - size.w, y: below },
        bottom: { x: centered, y: below },
        left: { x: rect.x - size.w - reach, y: middle },
        right: { x: rect.x + rect.w + reach, y: middle },
        inside: { x: rect.x + INSIDE_INSET.x, y: rect.y + INSIDE_INSET.y },
    };
    const spot = spots[position];

    return { x: spot.x + (request.offset?.x ?? 0), y: spot.y + (request.offset?.y ?? 0), w: size.w, h: size.h };
}

function leaderFor(
    request: LabelRequest,
    position: LabelPosition,
    chip: AnnotationRect
): PlacedLabel["leader"] | undefined {
    if (!hasLeader(request, position)) {
        return undefined;
    }

    const y = chip.y + chip.h / 2;

    if (position === "left") {
        return { from: { x: chip.x + chip.w, y }, to: { x: request.rect.x, y } };
    }

    return { from: { x: request.rect.x + request.rect.w, y }, to: { x: chip.x, y } };
}

export function rectsOverlap(a: AnnotationRect, b: AnnotationRect): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function rectInside(inner: AnnotationRect, outer: AnnotationRect): boolean {
    return (
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.w <= outer.x + outer.w &&
        inner.y + inner.h <= outer.y + outer.h
    );
}

/** One label: the first position of `fallbackOrder` whose chip lies inside `bounds` and covers no obstacle. */
export function placeLabel(input: {
    request: LabelRequest;
    bounds: AnnotationRect;
    obstacles: readonly AnnotationRect[];
}): LabelPlacement {
    const { request, bounds, obstacles } = input;
    const tried: LabelPosition[] = [];

    for (const position of fallbackOrder(request.position)) {
        tried.push(position);
        const chip = labelSpot(request, position);

        if (!rectInside(chip, bounds) || obstacles.some((obstacle) => rectsOverlap(chip, obstacle))) {
            continue;
        }

        const leader = leaderFor(request, position, chip);
        const label: PlacedLabel = { chip, position, moved: position !== request.position };

        return { ok: true, label: leader ? { ...label, leader } : label };
    }

    return { ok: false, tried };
}

/** Labels in order; each placed chip becomes an obstacle for the labels after it. */
export function placeLabels(input: {
    requests: readonly LabelRequest[];
    bounds: AnnotationRect;
    obstacles: readonly AnnotationRect[];
}): LabelPlacement[] {
    const taken = [...input.obstacles];

    return input.requests.map((request) => {
        const placement = placeLabel({ request, bounds: input.bounds, obstacles: taken });

        if (placement.ok) {
            taken.push(placement.label.chip);
        }

        return placement;
    });
}

/** The requested spot pushed back inside the bounds: the fallback when no position fits. */
export function clampedSpot(request: LabelRequest, bounds: AnnotationRect): PlacedLabel {
    const spot = labelSpot(request, request.position);
    const chip = {
        ...spot,
        x: Math.max(bounds.x, Math.min(spot.x, bounds.x + bounds.w - spot.w)),
        y: Math.max(bounds.y, Math.min(spot.y, bounds.y + bounds.h - spot.h)),
    };
    const leader = leaderFor(request, request.position, chip);
    const label: PlacedLabel = { chip, position: request.position, moved: false };

    return leader ? { ...label, leader } : label;
}
