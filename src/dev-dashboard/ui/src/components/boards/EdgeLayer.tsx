import type { CardDto, EdgeDto } from "@app/dev-dashboard/contract/dto";

interface EdgeLayerProps {
    edges: EdgeDto[];
    cards: CardDto[];
}

/** One absolutely-positioned SVG spanning the world; overflow-visible so it never clips lines. */
export function EdgeLayer({ edges, cards }: EdgeLayerProps) {
    const cardById = new Map(cards.map((c) => [c.id, c]));

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

                const x1 = from.x + from.w;
                const y1 = from.y + from.h / 2;
                const x2 = to ? to.x : edge.toX;
                const y2 = to ? to.y + to.h / 2 : edge.toY;

                return (
                    <g key={edge.id}>
                        <line
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke="var(--dd-text-muted)"
                            strokeWidth={1.5}
                            markerEnd="url(#dd-edge-arrow)"
                        />
                        {edge.label ? (
                            <text
                                x={(x1 + x2) / 2}
                                y={(y1 + y2) / 2 - 4}
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
        </svg>
    );
}
