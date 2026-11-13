import { describe, expect, spyOn, test } from "bun:test";
import { contrastRatio } from "./color";
import { type DiagramLayer, LayerDiagram, layoutLayerDiagram } from "./layer-diagram";
import { ModelBrowser } from "./model-browser";
import { PropertyGrid } from "./property-grid";
import { mountDom } from "./test-dom";
import {
    borderPoint,
    connectorPoints,
    elementHeight,
    headBase,
    orthogonal,
    type UmlConnectorKind,
    UmlDiagram,
    type UmlDiagramModel,
    type UmlElement,
    UmlInspector,
    UmlWorkbench,
    umlConnectorHead,
} from "./uml-diagram";
import { CapacityGrid, Heatmap, SegmentBar } from "./viz";

const BANDS: DiagramLayer[] = [
    { id: "top", label: "Top", columns: [3, 2, 2, 3], nodes: [{ id: "editor", title: "Editor", colSpan: 4 }] },
    { id: "middle", label: "Middle", columns: [3, 2, 2, 3], nodes: [{ id: "gateway", title: "Gateway", colSpan: 4 }] },
    {
        id: "service",
        label: "Service",
        columns: [3, 2, 2, 3],
        nodes: [{ id: "service", title: "Service", colSpan: 4 }],
    },
    {
        id: "bottom",
        label: "Bottom",
        columns: [3, 2, 2, 3],
        nodes: [
            { id: "docs", title: "Documents", col: 2 },
            { id: "related", title: "Related", col: 4 },
        ],
    },
];
const EDGES = [
    { from: "editor", to: "docs" },
    { from: "editor", to: "related" },
];
const ELEMENT: UmlElement = {
    id: "a",
    name: "A",
    kind: "class",
    x: 20,
    y: 50,
    w: 180,
    attributes: [{ name: "id", type: "string", mark: "ok" }],
    tags: [{ name: "version", value: "2" }],
};
const MODEL: UmlDiagramModel = {
    name: "Example (draft)",
    width: 800,
    height: 500,
    elements: [ELEMENT, { id: "b", name: "B", kind: "interface", x: 500, y: 300, w: 180 }],
    connectors: [
        {
            id: "ab",
            kind: "composition",
            source: "a",
            target: "b",
            sourceRole: "owner",
            sourceCard: "1",
            targetRole: "parts",
            targetCard: "*",
        },
    ],
};

describe("diagram geometry", () => {
    test("four-band direct edges cross boxes before routing and clear them afterward", () => {
        const before = layoutLayerDiagram({ layers: BANDS, edges: EDGES, routing: "direct" });
        expect(before.edges.every((edge) => edge.crosses.includes("gateway") && edge.crosses.includes("service"))).toBe(
            true
        );
        const after = layoutLayerDiagram({ layers: BANDS, edges: EDGES });
        expect(after.edges.map((edge) => edge.crosses)).toEqual([[], []]);
        expect(after.edges.every((edge) => edge.lane !== undefined && edge.d.includes("Q"))).toBe(true);
        expect(after.edges[0].d).not.toBe(before.edges[0].d);
        const gateway = after.nodes.find((node) => node.node.id === "gateway");
        expect(gateway).toBeDefined();
        expect(
            after.edges.every(
                (edge) =>
                    (edge.lane ?? 0) < (gateway?.x ?? 0) || (edge.lane ?? 0) > (gateway?.x ?? 0) + (gateway?.w ?? 0)
            )
        ).toBe(true);
    });
    test("automatic nodes leave a later pinned node its requested column", () => {
        const layout = layoutLayerDiagram({
            layers: [
                {
                    id: "row",
                    label: "Row",
                    columns: [1, 1],
                    nodes: [
                        { id: "auto", title: "Automatic" },
                        { id: "pinned", title: "Pinned", col: 1 },
                    ],
                },
            ],
        });
        expect(layout.nodes.map((placed) => placed.node.id)).toEqual(["auto", "pinned"]);
        const automatic = layout.nodes.find((placed) => placed.node.id === "auto");
        const pinned = layout.nodes.find((placed) => placed.node.id === "pinned");
        expect(automatic).toBeDefined();
        expect(pinned).toBeDefined();
        expect(pinned?.x).toBeLessThan(automatic?.x ?? 0);
    });

    test("explicit starts leave empty cells and column lanes need no viewBox x", () => {
        const layers: DiagramLayer[] = BANDS.map((band, i) =>
            i === 1 || i === 2 ? { ...band, nodes: [{ id: band.id, title: band.label, col: 3 }] } : band
        );
        const layout = layoutLayerDiagram({ layers, edges: [{ ...EDGES[0], lane: 1 }] });
        const middle = layout.nodes.find((node) => node.node.id === "middle");
        expect(middle?.x).toBeGreaterThan(600);
        expect(layout.edges[0].crosses).toEqual([]);
        expect(layout.edges[0].lane).toBeGreaterThan(190);
        expect(layout.edges[0].lane).toBeLessThan(middle?.x ?? 0);
    });
    test("an explicitly blocked lane reports its remaining collisions", () => {
        const layout = layoutLayerDiagram({ layers: BANDS, edges: [{ ...EDGES[0], lane: 1 }] });
        expect(layout.edges[0].crosses).toEqual(["gateway", "service"]);
        expect(layout.edges[0].lane).toBeDefined();
    });
    test("an explicitly blocked lane draws above the boxes with a three-pixel halo", async () => {
        const dom = await mountDom(
            <LayerDiagram title="Blocked explicit lane" layers={BANDS} edges={[{ ...EDGES[0], lane: 1 }]} />
        );
        try {
            const halo = dom.container.querySelector('path[stroke-width="7.6"]');
            const arrow = dom.container.querySelector('path[stroke-width="1.6"]');
            expect(halo).not.toBeNull();
            expect(halo?.getAttribute("d")).toBe(arrow?.getAttribute("d"));
            const boxes = dom.container.querySelectorAll('rect[stroke-width="1.6"]');
            expect(
                boxes[boxes.length - 1].compareDocumentPosition(halo ?? boxes[0]) &
                    dom.window.Node.DOCUMENT_POSITION_FOLLOWING
            ).toBeTruthy();
        } finally {
            await dom.unmount();
        }
    });
    test("border points lie on each facing border and coincident centres stay finite", () => {
        const h = elementHeight(ELEMENT);
        expect(borderPoint(ELEMENT, { x: 1000, y: 50 + h / 2 })).toEqual({ x: 200, y: 50 + h / 2 });
        expect(borderPoint(ELEMENT, { x: -1000, y: 50 + h / 2 })).toEqual({ x: 20, y: 50 + h / 2 });
        expect(borderPoint(ELEMENT, { x: 110, y: 1000 })).toEqual({ x: 110, y: 50 + h });
        expect(borderPoint(ELEMENT, { x: 110, y: -1000 })).toEqual({ x: 110, y: 50 });
        expect(borderPoint(ELEMENT, { x: 110, y: 50 + h / 2 })).toEqual({ x: 200, y: 50 + h / 2 });
    });
    test("a self-reference loops outside its element with two distinct border attachments", () => {
        const h = elementHeight(ELEMENT);
        const points = connectorPoints({}, ELEMENT, ELEMENT);
        const inside = (p: { x: number; y: number }) => p.x > 20 && p.x < 200 && p.y > 50 && p.y < 50 + h;
        expect(points.some(inside)).toBe(false);
        expect(points[0]).not.toEqual(points[points.length - 1]);
        expect(points[0].y).toBe(50);
        expect(points[points.length - 1].x).toBe(200);
        const base = headBase(points);
        expect(base.x).toBeGreaterThan(200);
    });
    test("a via point on the target border does not turn the head sideways", () => {
        const target: UmlElement = { ...ELEMENT, id: "b", y: 400 };
        const onTop = { x: 110, y: 400 };
        const points = connectorPoints({ via: [{ x: 110, y: 300 }, onTop] }, ELEMENT, target);
        const tip = points[points.length - 1];
        const base = headBase(points);
        expect(tip).toEqual(onTop);
        expect(Math.atan2(tip.y - base.y, tip.x - base.x)).toBeCloseTo(Math.PI / 2);
    });
    test("close vertically separated UML boxes use their facing borders in either direction", () => {
        const source: UmlElement = { id: "source", name: "Source", kind: "class", x: 20, y: 50, w: 180 };
        const target: UmlElement = { ...source, id: "target", name: "Target", y: 50 + elementHeight(source) + 7 };
        for (const [from, to] of [
            [source, target],
            [target, source],
        ]) {
            const route = orthogonal(from, to);
            const down = to.y > from.y;
            expect(route).toEqual([
                { x: 110, y: down ? from.y + elementHeight(from) : from.y },
                { x: 110, y: down ? to.y : to.y + elementHeight(to) },
            ]);
        }
    });

    test("orthogonal connectors attach to borders and each segment has one fixed axis", () => {
        const source = MODEL.elements[0];
        const target = MODEL.elements[1];
        for (const [a, b] of [
            [source, target],
            [target, source],
            [source, { ...target, y: source.y }],
        ]) {
            const points = orthogonal(a, b);
            expect(
                points[0].y === a.y ||
                    points[0].y === a.y + elementHeight(a) ||
                    points[0].x === a.x ||
                    points[0].x === a.x + a.w
            ).toBe(true);
            const end = points[points.length - 1];
            expect(end.y === b.y || end.y === b.y + elementHeight(b) || end.x === b.x || end.x === b.x + b.w).toBe(
                true
            );
            expect(points.slice(1).every((point, i) => point.x === points[i].x || point.y === points[i].y)).toBe(true);
        }
    });
    test("all UML connector heads and dashed line kinds have the required notation", () => {
        const kinds: UmlConnectorKind[] = [
            "association",
            "aggregation",
            "composition",
            "generalization",
            "realization",
            "dependency",
            "usage",
            "noteLink",
        ];
        expect(kinds.map((kind) => umlConnectorHead({ kind }))).toEqual([
            { shape: "none", filled: false },
            { shape: "diamond", filled: false },
            { shape: "diamond", filled: true },
            { shape: "triangle", filled: false },
            { shape: "triangle", filled: false, dash: "6 4" },
            { shape: "arrow", filled: false, dash: "6 4" },
            { shape: "arrow", filled: false, dash: "6 4" },
            { shape: "none", filled: false, dash: "2 3" },
        ]);
        expect(umlConnectorHead({ kind: "association", directed: true }).shape).toBe("arrow");
    });
    test("SVG selection supports keyboard and independent diagrams have unique gradient ids", async () => {
        const chosen: string[] = [];
        const dom = await mountDom(
            <>
                <UmlDiagram model={MODEL} selected="a" onSelect={(id) => chosen.push(id)} />
                <UmlDiagram model={MODEL} theme="classic" />
            </>
        );
        try {
            const box = dom.container.querySelector('[data-uml-element="a"]');
            expect(box?.getAttribute("aria-pressed")).toBe("true");
            await dom.press(box, "Enter");
            await dom.press(box, " ");
            expect(chosen).toEqual(["a", "a"]);
            const ids = [...dom.container.querySelectorAll("linearGradient")].map((gradient) => gradient.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(dom.container.textContent).toContain("owner");
            expect(dom.container.textContent).toContain("parts");
            expect(dom.container.textContent).toContain("version = 2");
        } finally {
            await dom.unmount();
        }
    });
    test("empty via arrays use the orthogonal default", async () => {
        const dom = await mountDom(
            <UmlDiagram model={{ ...MODEL, connectors: [{ ...MODEL.connectors[0], via: [] }] }} />
        );
        try {
            expect(dom.container.querySelector('[data-uml-connector="ab"] polyline')?.getAttribute("points")).toContain(
                ","
            );
        } finally {
            await dom.unmount();
        }
    });
    test("model branches collapse with a keyboard button and marks remain spoken", async () => {
        const dom = await mountDom(
            <ModelBrowser
                root={[
                    {
                        name: "Models",
                        icon: "package",
                        children: [{ name: "Key", icon: "primitiveType", mark: "new" }],
                    },
                ]}
            />
        );
        try {
            const branch = () => dom.container.querySelector("li ul");
            expect(dom.container.textContent).toContain("Keynew");
            await dom.click(dom.container.querySelector('button[aria-label="Collapse Models"]'));
            expect(branch()?.hasAttribute("hidden")).toBe(true);
            await dom.click(dom.container.querySelector('button[aria-label="Expand Models"]'));
            expect(branch()?.hasAttribute("hidden")).toBe(false);
            expect(dom.container.textContent).toContain("Keynew");
        } finally {
            await dom.unmount();
        }
    });
    test("collapsing a branch keeps what its descendants had open or closed", async () => {
        const dom = await mountDom(
            <ModelBrowser
                root={[
                    {
                        name: "Models",
                        icon: "package",
                        children: [
                            { name: "Inner", icon: "package", children: [{ name: "Leaf", icon: "primitiveType" }] },
                        ],
                    },
                ]}
            />
        );
        try {
            await dom.click(dom.container.querySelector('button[aria-label="Collapse Inner"]'));
            await dom.click(dom.container.querySelector('button[aria-label="Collapse Models"]'));
            await dom.click(dom.container.querySelector('button[aria-label="Expand Models"]'));
            // Inner comes back closed, as the user left it, not reset to its model default (open).
            expect(dom.container.querySelector('button[aria-label="Expand Inner"]')).not.toBeNull();
        } finally {
            await dom.unmount();
        }
    });
    test("model browser tabs switch the tree, and no tab strip is drawn without tab contents", async () => {
        const plain = await mountDom(<ModelBrowser root={[{ name: "Models", icon: "package" }]} />);
        try {
            expect(plain.container.querySelectorAll('[role="tab"]').length).toBe(0);
            expect(plain.container.textContent).not.toContain("Project");
        } finally {
            await plain.unmount();
        }

        const dom = await mountDom(
            <ModelBrowser
                root={[]}
                tabRoots={{
                    Project: [{ name: "Models", icon: "package" }],
                    Diagram: [{ name: "Overview", icon: "diagram" }],
                }}
            />
        );
        try {
            expect(dom.container.textContent).toContain("Models");
            await dom.click(dom.container.querySelectorAll('[role="tab"]')[1]);
            expect(dom.container.textContent).toContain("Overview");
            expect(dom.container.textContent).not.toContain("Models");
        } finally {
            await dom.unmount();
        }
    });
    test("property tabs change actual groups and keep row hints and footer", async () => {
        const groups = [
            {
                title: "Attribute",
                rows: [{ label: "Type", value: "string", mark: "ok" as const, hint: "Typed manually" }],
            },
        ];
        const dom = await mountDom(
            <PropertyGrid
                groups={groups}
                tabGroups={{ Attribute: groups, Tags: [{ title: "Tags", rows: [{ label: "version", value: "2" }] }] }}
                footer="Review complete"
            />
        );
        try {
            expect(dom.container.textContent).toContain("Typed manually");
            await dom.click(dom.container.querySelectorAll('[role="tab"]')[1]);
            expect(dom.container.textContent).toContain("version");
            expect(dom.container.textContent).not.toContain("Typed manually");
            expect(dom.container.textContent).toContain("Review complete");
        } finally {
            await dom.unmount();
        }
    });
    test("workbench owns selection used by the inspector", async () => {
        const dom = await mountDom(
            <UmlWorkbench initialSelected="a">
                {({ selected, setSelected }) => (
                    <>
                        <UmlDiagram model={MODEL} selected={selected} onSelect={setSelected} />
                        <UmlInspector element={MODEL.elements.find((element) => element.id === selected)} />
                    </>
                )}
            </UmlWorkbench>
        );
        try {
            expect(dom.container.textContent).toContain("id: string");
            await dom.click(dom.container.querySelector('[data-uml-element="b"]'));
            expect(dom.container.querySelector('[data-uml-element="b"]')?.getAttribute("aria-pressed")).toBe("true");
            expect(dom.container.textContent).toContain("interface");
        } finally {
            await dom.unmount();
        }
    });
    test("dev warning is emitted once for a direct diagram with unresolved crossings", async () => {
        const warning = spyOn(console, "warn").mockImplementation(() => undefined);
        const dom = await mountDom(<div />);
        const script = dom.window.document.createElement("script");
        script.src = "/@vite/client";
        dom.window.document.head.append(script);
        try {
            await dom.render(<LayerDiagram title="Direct" layers={BANDS} edges={EDGES} routing="direct" />);
            await dom.render(<LayerDiagram title="Direct" layers={BANDS} edges={EDGES} routing="direct" />);
            expect(warning).toHaveBeenCalledTimes(1);
        } finally {
            warning.mockRestore();
            await dom.unmount();
        }
    });
});

describe("filled visualization contrast", () => {
    test("heat, capacity and segment labels choose AA ink for resolved light and dark fills", async () => {
        const dom = await mountDom(<div />);
        const nativeComputed = globalThis.getComputedStyle;
        let fill = "color(srgb 0.27 0.565 0.725)";
        const computed = spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudo) => {
            const style = nativeComputed(element, pseudo);
            if (element.hasAttribute("data-readable-fill")) {
                Object.defineProperty(style, "backgroundColor", { value: fill });
            }

            return style;
        });
        const view = () => (
            <>
                <Heatmap rows={["a"]} cols={["1"]} values={[[30]]} />
                <CapacityGrid cols={["1"]} rows={[{ label: "A", load: [12], capacity: 10 }]} />
                <SegmentBar segments={[{ label: "Work", sub: "M", color: "var(--info)" }]} />
            </>
        );
        try {
            for (const background of [
                "color(srgb 0.27 0.565 0.725)",
                "color(srgb 0.17 0.533 0.7)",
                "rgb(245, 243, 238)",
                "rgb(15, 18, 24)",
            ]) {
                fill = background;
                await dom.render(view());
                const cells = [...dom.container.querySelectorAll<HTMLElement>("[data-readable-fill]")];
                expect(cells).toHaveLength(3);
                expect(cells.every((cell) => contrastRatio(cell.style.color, fill) >= 4.5)).toBe(true);
            }

            expect(dom.container.querySelector('[data-status="over"]')?.getAttribute("style")).toContain("outline");
            expect(dom.container.querySelector("small")?.className).not.toContain("opacity");
            expect(dom.container.textContent).toContain("over capacity by 2");
        } finally {
            computed.mockRestore();
            await dom.unmount();
        }
    });
    test("disabling heat removes the computed fill foreground", async () => {
        const dom = await mountDom(<CapacityGrid cols={["S1"]} rows={[{ label: "A", load: [12], capacity: 10 }]} />);
        try {
            expect(dom.container.querySelector<HTMLElement>("td")?.style.color).not.toBe("");
            await dom.render(
                <CapacityGrid heat={false} cols={["S1"]} rows={[{ label: "A", load: [12], capacity: 10 }]} />
            );
            expect(dom.container.querySelector<HTMLElement>("td")?.style.color).toBe("");
            expect(dom.container.querySelector("[data-readable-fill]")).toBeNull();
        } finally {
            await dom.unmount();
        }
    });
});
