import type { CardDto, EdgeDto } from "@app/dev-dashboard/contract/dto";
import { nearestSidePair, nearestSideToPoint } from "./edge-anchor";

interface EdgeLayerProps {
    edges: EdgeDto[];
    cards: CardDto[];
    /** The connect tool's in-progress drag, drawn as a dashed preview. */
    liveEdge?: { fromCardId: number; current: { x: number; y: number } } | null;
}

/** One absolutely-positioned SVG spanning the world; overflow-visible so it never clips lines. */
export function EdgeLayer({ edges, cards, liveEdge }: EdgeLayerProps) {
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const liveFrom = liveEdge ? cardById.get(liveEdge.fromCardId) : null;
    const liveStart = liveFrom && liveEdge ? nearestSideToPoint(liveFrom, liveEdge.current) : null;

    return (
        <svg className="absolute top-0 left-0 overflow-visible" style={{ pointerEvents: "none" }}>
            <defs>
                <marker
                    id="dd-edge-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                >
                    <path d="M0,0 L10,5 L0,10 z" fill="var(--dd-text-muted)" />
                </marker>
            </defs>
            {edges.map((edge) => {
                const from = cardById.get(edge.fromCard);

                if (!from) {
                    return null;
                }

                const to = edge.toCard != null ? cardById.get(edge.toCard) : null;

                if (edge.toCard != null && !to) {
                    // Stale reference to a card that's since been deleted.
                    return null;
                }

                const [p1, p2] = to
                    ? nearestSidePair(from, to)
                    : [nearestSideToPoint(from, { x: edge.toX, y: edge.toY }), { x: edge.toX, y: edge.toY }];

                return (
                    <g key={edge.id}>
                        <line
                            x1={p1.x}
                            y1={p1.y}
                            x2={p2.x}
                            y2={p2.y}
                            stroke="var(--dd-text-muted)"
                            strokeWidth={1.5}
                            markerEnd="url(#dd-edge-arrow)"
                        />
                        {edge.label ? (
                            <text
                                x={(p1.x + p2.x) / 2}
                                y={(p1.y + p2.y) / 2 - 4}
                                textAnchor="middle"
                                fontFamily="monospace"
                                fontSize={10}
                                fill="var(--dd-text-muted)"
                            >
                                {edge.label}
                            </text>
                        ) : null}
                    </g>
                );
            })}
            {liveStart && liveEdge ? (
                <line
                    x1={liveStart.x}
                    y1={liveStart.y}
                    x2={liveEdge.current.x}
                    y2={liveEdge.current.y}
                    stroke="var(--dd-accent-from)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                />
            ) : null}
        </svg>
    );
}
