import type { CardDto, StrokeDto } from "@app/dev-dashboard/contract/dto";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useMemo } from "react";
import { getCardScaleFactor } from "./AnnotationLayer";

/** Convert a stroke's stored path to world-space points. Card-scoped strokes are stored in
 * the card's natural-image pixel space and need scaling by card.w / naturalWidth; board-level
 * strokes (cardId null) are already world coordinates. */
export function strokeToWorldPath(
    stroke: Pick<StrokeDto, "path" | "cardId">,
    cardById: Map<number, CardDto>
): number[][] {
    if (stroke.cardId == null) {
        return stroke.path;
    }

    const card = cardById.get(stroke.cardId);

    if (!card) {
        return [];
    }

    const factor = getCardScaleFactor(card);
    return stroke.path.map(([x, y]) => [card.x + x * factor, card.y + y * factor]);
}

function distancePointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }

    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Shortest distance from a world point to a world-space polyline — used for eraser hit-testing. */
export function distanceToPolyline(point: { x: number; y: number }, path: number[][]): number {
    if (path.length === 0) {
        return Number.POSITIVE_INFINITY;
    }

    if (path.length === 1) {
        return Math.hypot(point.x - path[0][0], point.y - path[0][1]);
    }

    let min = Number.POSITIVE_INFINITY;

    for (let i = 0; i < path.length - 1; i++) {
        const [ax, ay] = path[i];
        const [bx, by] = path[i + 1];
        min = Math.min(min, distancePointToSegment(point.x, point.y, ax, ay, bx, by));
    }

    return min;
}

interface InkLayerProps {
    strokes: StrokeDto[];
    cards: CardDto[];
    liveStroke: number[][] | null;
    selectedStrokeId?: number | null;
    /** Live translation of the stroke being dragged (world units). */
    dragOverride?: { id: number; dx: number; dy: number } | null;
    /** When set (move tool), strokes are hit-testable: click selects, drag moves. */
    onStrokePointerDown?: (stroke: StrokeDto, e: ReactPointerEvent) => void;
}

/** Persisted + in-progress ink, rendered inside the world transform. The gesture capture that
 * drives `liveStroke` lives in BoardCanvas's shared overlay; in move tool each stroke also
 * exposes a wide invisible hit line for select/drag. */
export function InkLayer({
    strokes,
    cards,
    liveStroke,
    selectedStrokeId,
    dragOverride,
    onStrokePointerDown,
}: InkLayerProps) {
    const cardById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

    return (
        <svg className="absolute top-0 left-0 overflow-visible" style={{ pointerEvents: "none" }}>
            {strokes.map((stroke) => {
                let worldPath = strokeToWorldPath(stroke, cardById);

                if (worldPath.length < 2) {
                    return null;
                }

                if (dragOverride && dragOverride.id === stroke.id) {
                    worldPath = worldPath.map(([x, y]) => [x + dragOverride.dx, y + dragOverride.dy]);
                }

                const points = worldPath.map(([x, y]) => `${x},${y}`).join(" ");
                const selected = stroke.id === selectedStrokeId;

                return (
                    <g key={stroke.id}>
                        {onStrokePointerDown ? (
                            <polyline
                                points={points}
                                fill="none"
                                stroke="transparent"
                                strokeWidth={Math.max(12, stroke.width * 3)}
                                style={{ pointerEvents: "stroke", cursor: "move" }}
                                onPointerDown={(e) => onStrokePointerDown(stroke, e)}
                            />
                        ) : null}
                        <polyline
                            points={points}
                            fill="none"
                            stroke={selected ? "var(--dd-accent-from)" : stroke.color}
                            strokeWidth={stroke.width}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </g>
                );
            })}
            {liveStroke && liveStroke.length > 1 ? (
                <polyline
                    points={liveStroke.map(([x, y]) => `${x},${y}`).join(" ")}
                    fill="none"
                    stroke="#e33352"
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            ) : null}
        </svg>
    );
}
