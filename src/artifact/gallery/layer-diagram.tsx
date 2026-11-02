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
