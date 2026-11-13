import { type DiagramEdge, type DiagramLayer, HUE, LayerDiagram } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Diagrams",
    title: "Layer diagram",
    summary:
        "LayerDiagram: bands of boxes on a column grid, arrows and bus lines, drawn as SVG in the page. Offline, themed, no Mermaid.",
    components: ["LayerDiagram", "layoutLayerDiagram"],
};

const LAYERS: DiagramLayer[] = [
    {
        id: "clients",
        label: "Clients",
        sub: ["who asks"],
        color: HUE.rose,
        nodes: [
            { id: "cli", title: "Terminal", lines: ["scripts, TUI"] },
            { id: "app", title: "Desktop app", lines: ["window, widget"], weight: 1.5 },
            { id: "agents", title: "Agents", lines: ["MCP clients"] },
        ],
    },
    {
        id: "doors",
        label: "Doors",
        sub: ["thin adapters"],
        color: HUE.amber,
        nodes: [
            { id: "command", title: "CLI", lines: ["one root command"], weight: 2.5 },
            { id: "mcp", title: "MCP", lines: ["tools"], dashed: true },
        ],
    },
    {
        id: "core",
        label: "Core",
        sub: ["one library"],
        color: HUE.sky,
        bus: true,
        nodes: [
            {
                id: "contract",
                title: "query/  window · selector · envelope",
                tint: true,
                dashed: true,
                color: HUE.teal,
            },
        ],
        nodeHeight: 54,
        padding: 8,
    },
    {
        id: "stores",
        label: "Stores",
        sub: ["files, SQLite"],
        color: HUE.slate,
        titles: "ink",
        columns: [2, 1, 1],
        rows: 2,
        nodeHeight: 56,
        bus: true,
        nodes: [
            { id: "db", title: "index.db", lines: ["snapshots", "events", "rollups"], rowSpan: 2 },
            { id: "json", title: "latest.json", lines: ["last reading"] },
            { id: "ledger", title: "ledger", lines: ["metered calls"] },
            { id: "pins", title: "pin journal", lines: ["session to account"], colSpan: 2 },
        ],
    },
];

const EDGES: DiagramEdge[] = [
    { from: "cli", to: "command" },
    { from: "app", to: "command", label: "--json" },
    { from: "agents", to: "mcp" },
    { from: "command", to: "contract" },
    { from: "mcp", to: "contract" },
    { to: "db" },
    { to: "ledger" },
    { from: "contract", to: "missing-box" },
];

const SKIPPED_BANDS: DiagramLayer[] = [
    { id: "editors", label: "Editors", columns: [3, 2, 2, 3], nodes: [{ id: "editor", title: "Editor", colSpan: 4 }] },
    { id: "gateway", label: "Gateway", columns: [3, 2, 2, 3], nodes: [{ id: "bff", title: "BFF", colSpan: 4 }] },
    {
        id: "service",
        label: "Service",
        columns: [3, 2, 2, 3],
        nodes: [{ id: "service", title: "Service", colSpan: 4 }],
    },
    {
        id: "content",
        label: "Content",
        columns: [3, 2, 2, 3],
        nodes: [
            { id: "docs", title: "Documents", col: 2 },
            { id: "related", title: "Related records", col: 4 },
        ],
    },
];
export default function LayerDiagramPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="The frame takes focus with Tab, so the arrow keys scroll it when the drawing is wider than the page. A screen reader hears the title, then each band with its boxes and the arrows between them."
        >
            <Demo title="Four bands, weighted columns, a tinted contract, a grid band with row and column spans">
                <LayerDiagram title="Clients, doors, core and stores" layers={LAYERS} edges={EDGES} />
            </Demo>
            <Demo
                title="Before: a direct arrow hides behind intermediate boxes"
                note="The legacy direct route can look as though it calls the intermediate gateway. Both examples use the same connections."
            >
                <LayerDiagram
                    title="Direct path hidden behind the gateway"
                    routing="direct"
                    layers={SKIPPED_BANDS}
                    edges={[
                        { from: "editor", to: "docs", label: "direct" },
                        { from: "editor", to: "related", lane: "right" },
                    ]}
                />
            </Demo>
            <Demo
                title="After: direct connections skip occupied bands"
                note="No viewBox coordinates are needed. Both direct arrows automatically leave the occupied bands through a free side lane."
            >
                <LayerDiagram
                    title="Editor calls content directly"
                    layers={SKIPPED_BANDS}
                    edges={[
                        { from: "editor", to: "docs", label: "direct" },
                        { from: "editor", to: "related", lane: "right" },
                    ]}
                />
            </Demo>
            <Demo
                title="Choose a column gap, or leave a cell empty"
                note="col is a 1-based start column; lane 1 is the gap after column 1."
            >
                <LayerDiagram
                    title="Empty cells preserve a direct lane"
                    layers={SKIPPED_BANDS.map((layer, i) =>
                        i === 1 || i === 2
                            ? { ...layer, nodes: [{ id: `${layer.id}-small`, title: layer.label, col: 3 }] }
                            : layer
                    )}
                    edges={[{ from: "editor", to: "docs", lane: 1 }]}
                />
            </Demo>
            <Demo
                title="Edge case: an arrow to a box that does not exist is skipped"
                note="the last edge above names missing-box; nothing is drawn for it"
            >
                <LayerDiagram
                    title="One band"
                    minWidth={480}
                    width={720}
                    layers={[
                        {
                            id: "only",
                            label: "Only",
                            color: HUE.violet,
                            nodes: [
                                { id: "a", title: "A" },
                                { id: "b", title: "B", dashed: true },
                            ],
                        },
                    ]}
                    edges={[{ from: "a", to: "nowhere" }]}
                />
            </Demo>
        </GalleryPage>
    );
}
