import { useId } from "react";

/**
 * A layered architecture diagram drawn as SVG in the page, with no library
 * and no network: horizontal bands (surfaces, doors, core, stores), boxes in
 * each band on a column grid, arrows between boxes and thick bus lines between
 * bands. Coordinates are in viewBox units; the frame scales the drawing to its
 * width and scrolls below `minWidth`. Colours are CSS colours, so `HUE` or the
 * tones retint it with the theme.
 */

export interface DiagramNode {
    id: string;
    title: string;
    /** Smaller lines under the title. */
    lines?: string[];
    /** Stroke and title colour; default the layer's colour. */
    color?: string;
    /** A dashed outline: a new part. */
    dashed?: boolean;
    /** Fill tinted with the colour (the one shared contract, say). */
    tint?: boolean;
    /** Column weight when the layer has no `columns`. Default 1. */
    weight?: number;
    /** Columns this box covers when the layer has `columns`. Default 1. */
    colSpan?: number;
    /** Rows this box covers when the layer has `rows`. Default 1. */
    rowSpan?: number;
}

export interface DiagramLayer {
    id: string;
    /** Band label on the left. */
    label: string;
    /** Smaller lines under the label. */
    sub?: string[];
    /** Default colour of the layer's boxes. */
    color?: string;
    /** "ink": box titles in the text colour instead of the box colour (plain stores). */
    titles?: "color" | "ink";
    nodes: DiagramNode[];
    /** Column weights; boxes then fill the grid row by row with `colSpan` and `rowSpan`. Default: one column per box, sized by `weight`. */
    columns?: number[];
    /** Rows of boxes in the band. Default 1. */
    rows?: number;
    /** Box height. Default 64. */
    nodeHeight?: number;
    /** Gap between rows of boxes. Default 10. */
    rowGap?: number;
    /** Space between the band edge and its boxes. Default 10. */
    padding?: number;
    /** Draw a thick bus line in the gap above this band. */
    bus?: boolean;
}

export interface DiagramEdge {
    /** Source box id. Omit it to start at the bottom of the band above the target (an arrow off a bus). */
    from?: string;
    /** Target box id. */
    to: string;
    /** Small text beside the arrow ("--json"). */
    label?: string;
    /** Horizontal position in viewBox units; default the source's centre (or the target's without a source). */
    x?: number;
}

export interface LayerDiagramProps {
    layers: DiagramLayer[];
    edges?: DiagramEdge[];
    /** Accessible title of the drawing. */
    title: string;
    /** viewBox width. Default 1200. */
    width?: number;
    /** Width of the label column. Default 180. */
    labelWidth?: number;
    /** Gap between bands. Default 30. */
    gap?: number;
    /** Narrowest CSS width before the frame scrolls. Default 980. */
    minWidth?: number;
}

export interface PlacedNode {
    node: DiagramNode;
    layer: number;
    x: number;
    y: number;
    w: number;
    h: number;
    color: string;
    titleColor: string;
}

export interface PlacedBand {
    layer: DiagramLayer;
    y: number;
    h: number;
}

export interface PlacedEdge {
    edge: DiagramEdge;
    /** The box the arrow leaves; none for an arrow off the band above (a bus). */
    source?: PlacedNode;
    target: PlacedNode;
    d: string;
    label?: { text: string; x: number; y: number };
}

export interface LayerDiagramLayout {
    width: number;
    height: number;
    bands: PlacedBand[];
    nodes: PlacedNode[];
    edges: PlacedEdge[];
    /** Bus lines: y and the x span. */
    buses: Array<{ y: number; x1: number; x2: number }>;
}

const MARGIN_TOP = 14;
const MARGIN_BOTTOM = 12;
const BAND_INSET = 10;
const COLUMN_GAP = 15;
const DEFAULT_COLOR = "var(--dim)";

/** Place every band, box, arrow and bus. Pure, so the geometry is tested without a DOM. */
export function layoutLayerDiagram({
    layers,
    edges = [],
    width = 1200,
    labelWidth = 180,
    gap = 30,
}: Omit<LayerDiagramProps, "title" | "minWidth">): LayerDiagramLayout {
    const left = BAND_INSET + labelWidth;
    const right = width - 2 * BAND_INSET;
    const bands: PlacedBand[] = [];
    const nodes: PlacedNode[] = [];
    const buses: LayerDiagramLayout["buses"] = [];
    let y = MARGIN_TOP;

    layers.forEach((layer, li) => {
        const rows = layer.rows ?? 1;
        const nodeHeight = layer.nodeHeight ?? 64;
        const rowGap = layer.rowGap ?? 10;
        const padding = layer.padding ?? 10;
        const h = padding * 2 + rows * nodeHeight + (rows - 1) * rowGap;

        if (li > 0 && layer.bus) {
            buses.push({ y: y - gap / 2, x1: left + 10, x2: right - 10 });
        }

        bands.push({ layer, y, h });

        const weights = layer.columns ?? layer.nodes.map((node) => node.weight ?? 1);
        const total = weights.reduce((sum, w) => sum + w, 0);
        const free = right - left - COLUMN_GAP * (weights.length - 1);
        const colX: number[] = [];
        const colW = weights.map((w) => (free * w) / total);
        let cx = left;

        for (const w of colW) {
            colX.push(cx);
            cx += w + COLUMN_GAP;
        }

        // Row-major auto-placement over an occupancy grid, the way CSS grid fills.
        const taken: boolean[][] = Array.from({ length: rows }, () => weights.map(() => false));
        const fits = (r: number, c: number, rs: number, cs: number) => {
            for (let rr = r; rr < r + rs; rr += 1) {
                for (let cc = c; cc < c + cs; cc += 1) {
                    if (rr >= rows || cc >= weights.length || taken[rr][cc]) {
                        return false;
                    }
                }
            }

            return true;
        };

        for (const node of layer.nodes) {
            const cs = layer.columns ? (node.colSpan ?? 1) : 1;
            const rs = layer.columns ? (node.rowSpan ?? 1) : 1;
            let slot: [number, number] | null = null;

            for (let r = 0; r < rows && !slot; r += 1) {
                for (let c = 0; c < weights.length && !slot; c += 1) {
                    if (fits(r, c, rs, cs)) {
                        slot = [r, c];
                    }
                }
            }

            if (!slot) {
                continue;
            }

            const [r, c] = slot;

            for (let rr = r; rr < r + rs; rr += 1) {
                for (let cc = c; cc < c + cs; cc += 1) {
                    taken[rr][cc] = true;
                }
            }

            const x = colX[c];
            const lastCol = c + cs - 1;
            const color = node.color ?? layer.color ?? DEFAULT_COLOR;

            nodes.push({
                node,
                layer: li,
                x,
                y: y + padding + r * (nodeHeight + rowGap),
                w: colX[lastCol] + colW[lastCol] - x,
                h: rs * nodeHeight + (rs - 1) * rowGap,
                color,
                titleColor: layer.titles === "ink" ? "var(--text)" : color,
            });
        }

        y += h + gap;
    });

    const height = y - gap + MARGIN_BOTTOM;
    const byId = new Map(nodes.map((placed) => [placed.node.id, placed]));
    const placedEdges: PlacedEdge[] = [];

    for (const edge of edges) {
        const target = byId.get(edge.to);

        if (!target) {
            continue;
        }

        const source = edge.from ? byId.get(edge.from) : undefined;

        if (edge.from && !source) {
            continue;
        }

        const above = bands[target.layer - 1];
        const y0 = source ? source.y + source.h : above ? above.y + above.h : target.y - gap;
        const y1 = target.y - 3;
        const x0 = edge.x ?? (source ? source.x + source.w / 2 : target.x + target.w / 2);
        const inside = x0 >= target.x + 12 && x0 <= target.x + target.w - 12;
        const x1 = inside ? x0 : target.x + target.w / 2;
        const mid = (y0 + y1) / 2;
        const d = inside ? `M${x0} ${y0} V ${y1}` : `M${x0} ${y0} C ${x0} ${mid}, ${x1} ${mid}, ${x1} ${y1}`;

        placedEdges.push({
            edge,
            source,
            target,
            d,
            label: edge.label ? { text: edge.label, x: x0 + 15, y: mid + 5 } : undefined,
        });
    }

    return { width, height, bands, nodes, edges: placedEdges, buses };
}

const TEXT_FONT = { fontFamily: "var(--font-code)" };

function NodeBox({ placed }: { placed: PlacedNode }) {
    const { node, x, y, w, h, color, titleColor } = placed;
    const lines = node.lines ?? [];
    const titleY = lines.length ? y + 26 : y + h / 2 + 5;

    return (
        <g>
            <rect
                x={x}
                y={y}
                width={w}
                height={h}
                rx={10}
                strokeWidth={1.6}
                stroke={color}
                strokeDasharray={node.dashed ? "6 4" : undefined}
                fill={node.tint ? `color-mix(in srgb, ${color} 10%, var(--panel-2))` : "var(--panel-2)"}
            />
            <text x={x + 14} y={titleY} fill={titleColor} fontSize={15} fontWeight={600} style={TEXT_FONT}>
                {node.title}
            </text>
            {lines.map((line, i) => (
                <text
                    key={`${i}-${line}`}
                    x={x + 14}
                    y={y + 48 + i * 23}
                    fill="var(--text-2)"
                    fontSize={14}
                    style={TEXT_FONT}
                >
                    {line}
                </text>
            ))}
        </g>
    );
}

function BandLabel({ band, x }: { band: PlacedBand; x: number }) {
    const subs = band.layer.sub ?? [];
    const block = 16 + 22 * subs.length;
    const top = band.y + (band.h - block) / 2 + 13;

    return (
        <g>
            <text
                x={x}
                y={top}
                fill="var(--text)"
                fontSize={16}
                fontWeight={700}
                style={{ fontFamily: "var(--font-heading)" }}
            >
                {band.layer.label}
            </text>
            {subs.map((sub, i) => (
                <text
                    key={`${i}-${sub}`}
                    x={x}
                    y={top + 22 * (i + 1)}
                    fill="var(--dim)"
                    fontSize={14}
                    style={TEXT_FONT}
                >
                    {sub}
                </text>
            ))}
        </g>
    );
}

/**
 * Words for a screen reader, from what is drawn: each band with its boxes and their lines, then every arrow,
 * those off a bus included. A box that found no slot and an arrow to a missing box are not drawn, so not said.
 */
function describe(layout: LayerDiagramLayout): string {
    const bands = layout.bands.map((band, li) => {
        const boxes = layout.nodes
            .filter((placed) => placed.layer === li)
            .map(({ node }) => (node.lines?.length ? `${node.title} (${node.lines.join(", ")})` : node.title));

        return `${band.layer.label}: ${boxes.join(", ")}.`;
    });
    const arrows = layout.edges.map(({ edge, source, target }) => {
        const band = layout.bands[target.layer];
        const above = layout.bands[target.layer - 1];
        const start = source
            ? source.node.title
            : above && band.layer.bus
              ? `the bus above ${band.layer.label}`
              : above?.layer.label;
        const words = start ? `${start} to ${target.node.title}` : `into ${target.node.title}`;

        return edge.label ? `${words} (${edge.label})` : words;
    });

    return [...bands, arrows.length ? `Arrows: ${arrows.join("; ")}.` : ""].join(" ").trim();
}

/** Layered architecture diagram, SVG drawn in the page (offline, themed). See the module comment. */
export function LayerDiagram({
    layers,
    edges = [],
    title,
    width = 1200,
    labelWidth = 180,
    gap = 30,
    minWidth = 980,
}: LayerDiagramProps) {
    const uid = useId().replace(/:/g, "");
    const layout = layoutLayerDiagram({ layers, edges, width, labelWidth, gap });
    const arrow = `akit-arrow-${uid}`;

    return (
        <div
            tabIndex={0}
            role="group"
            aria-label={title}
            className="overflow-x-auto rounded-[14px] border border-line bg-panel p-3 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-info"
        >
            <svg
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="img"
                aria-labelledby={`${uid}-title ${uid}-desc`}
                className="block h-auto w-full"
                style={{ minWidth }}
            >
                <title id={`${uid}-title`}>{title}</title>
                <desc id={`${uid}-desc`}>{describe(layout)}</desc>
                <defs>
                    <marker
                        id={arrow}
                        viewBox="0 0 10 10"
                        refX={9}
                        refY={5}
                        markerWidth={7}
                        markerHeight={7}
                        orient="auto-start-reverse"
                    >
                        <path d="M0,0 L10,5 L0,10 z" fill="var(--dim)" />
                    </marker>
                </defs>
                {layout.bands.map((band) => (
                    <rect
                        key={`band-${band.layer.id}`}
                        x={BAND_INSET}
                        y={band.y}
                        width={layout.width - 2 * BAND_INSET}
                        height={band.h}
                        rx={12}
                        fill="color-mix(in srgb, var(--text) 3%, transparent)"
                    />
                ))}
                {layout.bands.map((band) => (
                    <BandLabel key={`label-${band.layer.id}`} band={band} x={BAND_INSET + 16} />
                ))}
                {layout.buses.map((bus) => (
                    <line
                        key={`bus-${bus.y}`}
                        x1={bus.x1}
                        y1={bus.y}
                        x2={bus.x2}
                        y2={bus.y}
                        stroke="var(--border-2)"
                        strokeWidth={10}
                        strokeLinecap="round"
                    />
                ))}
                {layout.edges.map((edge, i) => (
                    <g key={i}>
                        <path
                            d={edge.d}
                            stroke="var(--dim)"
                            strokeWidth={1.6}
                            fill="none"
                            markerEnd={`url(#${arrow})`}
                        />
                        {edge.label ? (
                            <text
                                x={edge.label.x}
                                y={edge.label.y}
                                fill="var(--text-2)"
                                fontSize={14}
                                style={TEXT_FONT}
                            >
                                {edge.label.text}
                            </text>
                        ) : null}
                    </g>
                ))}
                {layout.nodes.map((placed) => (
                    <NodeBox key={placed.node.id} placed={placed} />
                ))}
            </svg>
        </div>
    );
}
