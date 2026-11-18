import { describe, expect, spyOn, test } from "bun:test";
import { contrastRatio } from "./color";
import {
    actualSizeView,
    type CompareSize,
    comparedAreaText,
    compareKey,
    diffImages,
    diffSummary,
    estimateShift,
    FIT_VIEW,
    GUTTER_LABEL_HEIGHT,
    gutterLabels,
    LEADER_TICK,
    matchRegion,
    PANE_MIN_HEIGHT,
    paneHeight,
    panKeyDelta,
    panView,
    percentAt,
    placeImage,
    type RgbaImage,
    resolveCompareImages,
    resolveView,
    shiftText,
    sliderKeyPercent,
    viewForRect,
    ZOOM_STEP,
    zoomViewAt,
    zoomViewBy,
} from "./image-compare/core";
import { heatMap } from "./image-compare/modes/heat";
import { type DiagramLayer, LayerDiagram, layoutLayerDiagram } from "./layer-diagram";
import { ModelBrowser } from "./model-browser";
import { PropertyGrid } from "./property-grid";
import { type DomHarness, mountDom } from "./test-dom";
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

/** Two-tab strip, second tab selected: one tab stop, and Left/Right/Home/End select and focus with wrapping. */
async function expectTabKeyboard(dom: DomHarness, contents: [string, string]): Promise<void> {
    const tabs = () => [...dom.container.querySelectorAll('[role="tab"]')];
    const selected = () => tabs().findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    const stops = () => tabs().filter((tab) => tab.getAttribute("tabindex") === "0");
    expect(stops()).toEqual([tabs()[1]]);
    await dom.press(tabs()[1], "ArrowRight");
    expect(selected()).toBe(0);
    expect(dom.window.document.activeElement).toBe(tabs()[0]);
    expect(stops()).toEqual([tabs()[0]]);
    expect(dom.container.textContent).toContain(contents[0]);
    await dom.press(tabs()[0], "ArrowLeft");
    expect(selected()).toBe(1);
    expect(dom.container.textContent).toContain(contents[1]);
    await dom.press(tabs()[1], "Home");
    expect(selected()).toBe(0);
    await dom.press(tabs()[0], "End");
    expect(selected()).toBe(1);
    expect(dom.window.document.activeElement).toBe(tabs()[1]);
}

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
    test("other rows of the endpoint bands are obstacles, and the route leaves and enters through a row gap", () => {
        const layers: DiagramLayer[] = [
            {
                id: "top",
                label: "Top",
                columns: [1, 1, 1],
                rows: 2,
                nodes: [
                    { id: "source", title: "Source", col: 2 },
                    { id: "below-source", title: "Below source", col: 2 },
                ],
            },
            {
                id: "bottom",
                label: "Bottom",
                columns: [1, 1, 1],
                rows: 2,
                nodes: [
                    { id: "above-target", title: "Above target", col: 2 },
                    { id: "target", title: "Target", col: 2 },
                ],
            },
        ];
        const edges = [{ from: "source", to: "target" }];
        const direct = layoutLayerDiagram({ layers, edges, routing: "direct" });
        expect(direct.edges[0].crosses).toEqual(["below-source", "above-target"]);
        const routed = layoutLayerDiagram({ layers, edges });
        expect(routed.edges[0].crosses).toEqual([]);
        const boxes = routed.nodes.filter((node) => node.node.id.includes("-"));
        const corners = [...routed.edges[0].d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
            x: Number(m[1]),
            y: Number(m[2]),
        }));
        for (let i = 1; i < corners.length; i += 1) {
            for (let t = 0; t <= 1; t += 0.05) {
                const x = corners[i - 1].x + (corners[i].x - corners[i - 1].x) * t;
                const y = corners[i - 1].y + (corners[i].y - corners[i - 1].y) * t;
                expect(boxes.filter((box) => x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h)).toEqual(
                    []
                );
            }
        }
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
            await expectTabKeyboard(dom, ["Models", "Overview"]);
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
            await expectTabKeyboard(dom, ["Typed manually", "version"]);
        } finally {
            await dom.unmount();
        }
    });
    test("a read-only UML diagram describes its elements and connectors in words", async () => {
        const dom = await mountDom(<UmlDiagram model={MODEL} />);
        try {
            const svg = dom.container.querySelector("svg");
            expect(svg?.getAttribute("role")).toBe("img");
            const desc = dom.window.document.getElementById(svg?.getAttribute("aria-describedby") ?? "");
            expect(desc?.tagName.toLowerCase()).toBe("desc");
            expect(desc?.textContent).toBe(
                "Class A; attributes id: string (ok); tags version = 2. Interface B. " +
                    "Composition from A to B; at A: role owner, multiplicity 1; at B: role parts, multiplicity *."
            );
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
                "oklch(95% 0 0)",
                "oklch(0.3 0.06 250)",
                "color(display-p3 0.95 0.92 0.6)",
            ]) {
                fill = background;
                await dom.render(view());
                const cells = [...dom.container.querySelectorAll<HTMLElement>("[data-readable-fill]")];
                expect(cells).toHaveLength(3);
                expect(cells.every((cell) => contrastRatio(cell.style.color, fill) >= 4.5)).toBe(true);
            }

            // A fill the colour maths cannot read keeps the stylesheet's ink instead of a guessed white.
            fill = "color(rec2020 0.9 0.9 0.9)";
            await dom.render(view());
            const unread = [...dom.container.querySelectorAll<HTMLElement>("[data-readable-fill]")];
            expect(unread.map((cell) => cell.style.color)).toEqual(["", "", ""]);

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

/** A solid image of one colour, optionally with a block of another. */
function solid({
    width,
    height,
    rgb,
    block,
}: {
    width: number;
    height: number;
    rgb: [number, number, number];
    block?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] };
}): RgbaImage {
    const data = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inBlock = block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
            const [r, g, b] = inBlock ? block.rgb : rgb;
            data.set([r, g, b, 255], (y * width + x) * 4);
        }
    }

    return { width, height, data };
}

describe("image compare core", () => {
    const WHITE: [number, number, number] = [255, 255, 255];
    const NAVY: [number, number, number] = [20, 30, 120];

    test("the diff counts a changed block, paints it pink and boxes it as one region", () => {
        const a = solid({ width: 40, height: 30, rgb: WHITE });
        const b = solid({ width: 40, height: 30, rgb: WHITE, block: { x: 10, y: 8, w: 6, h: 5, rgb: NAVY } });
        const diff = diffImages({ a, b, threshold: 0.15 });

        expect(diff.changed).toBe(30);
        expect(diff.total).toBe(1200);
        expect(diff.regions).toEqual([{ x: 10, y: 8, w: 6, h: 5, pixels: 30 }]);
        expect([...diff.overlay.slice((8 * 40 + 10) * 4, (8 * 40 + 10) * 4 + 4)]).toEqual([255, 45, 149, 255]);
        expect(diff.overlay[3]).toBe(0);
        expect(diffSummary(diff)).toBe("2.50% of pixels differ (30)");
        expect(diffSummary(diffImages({ a, b: a, threshold: 0.15 }))).toBe("No pixels differ");
    });

    test("different sizes share the larger canvas top-left, and pixels inside only one image count as changed", () => {
        const wide = solid({ width: 3, height: 1, rgb: WHITE });
        const padded = placeImage(wide, { width: 3, height: 3 });

        expect([...padded.data.slice(0, 12)]).toEqual([...wide.data]);
        expect([...padded.data.slice(12)].every((byte) => byte === 0)).toBe(true);

        // White on a white page would read as equal; the rows only one image has are still a change.
        const tall = solid({ width: 1, height: 3, rgb: WHITE });
        const diff = diffImages({ a: wide, b: tall, threshold: 0.15 });

        expect(diff.size).toEqual({ width: 3, height: 3 });
        expect(diff.changed).toBe(4);
    });

    test("ImageCompare takes before and after or two or more images, and refuses anything else", () => {
        expect(resolveCompareImages({ before: { src: "a.png" }, after: { src: "b.png", alt: "New" } })).toEqual([
            { src: "a.png", label: "Before", alt: "Before" },
            { src: "b.png", label: "After", alt: "New" },
        ]);
        expect(() => resolveCompareImages({ before: { src: "a.png" } })).toThrow("needs `before` and `after`");
        expect(() =>
            resolveCompareImages({ before: { src: "a.png" }, images: [{ src: "a.png", label: "A" }] })
        ).toThrow("not both");
        expect(() => resolveCompareImages({ images: [{ src: "a.png", label: "A" }] })).toThrow("at least two");
        expect(
            resolveCompareImages({
                images: [
                    { src: "a.png", label: "A" },
                    { src: "b.png", label: "B" },
                    { src: "c.png", label: "C" },
                ],
            }).map((image) => image.label)
        ).toEqual(["A", "B", "C"]);
    });

    test("the slider moves 2% per arrow, 10% with Shift, jumps with Home and End, and stays in 0 to 100", () => {
        expect(sliderKeyPercent({ key: "ArrowLeft", shift: false, value: 50 })).toBe(48);
        expect(sliderKeyPercent({ key: "ArrowRight", shift: true, value: 50 })).toBe(60);
        expect(sliderKeyPercent({ key: "ArrowLeft", shift: true, value: 4 })).toBe(0);
        expect(sliderKeyPercent({ key: "Home", shift: false, value: 50 })).toBe(0);
        expect(sliderKeyPercent({ key: "End", shift: false, value: 50 })).toBe(100);
        expect(sliderKeyPercent({ key: "a", shift: false, value: 50 })).toBeUndefined();
        expect(percentAt({ clientX: 150, left: 100, width: 200 })).toBe(25);
        expect(percentAt({ clientX: 400, left: 100, width: 200 })).toBe(100);
    });

    test("zoom keeps the point under the pointer, and a region view centres the region", () => {
        const pane = { width: 400, height: 300 };
        const canvas = { width: 1600, height: 1200 };
        const fit = resolveView({ scale: null, cx: 0, cy: 0 }, pane, canvas);

        expect(fit).toEqual({ scale: 0.25, x: 0, y: 0 });

        const point = { x: 100, y: 75 };
        const zoomed = resolveView(
            zoomViewAt({ view: { scale: null, cx: 0, cy: 0 }, pane, canvas, factor: 2, point }),
            pane,
            canvas
        );
        // Canvas point (400, 300) sat under the pointer before the zoom and still does.
        expect(zoomed.scale).toBe(0.5);
        expect(point.x - 400 * zoomed.scale).toBeCloseTo(zoomed.x);
        expect(point.y - 300 * zoomed.scale).toBeCloseTo(zoomed.y);

        const region = viewForRect({ rect: { x: 800, y: 600, w: 88, h: 38 }, pane, canvas });
        expect(region).toEqual({ scale: 4, cx: 844, cy: 619 });
    });

    test("a long screenshot that fits below 5% zooms out to its fit, never in, and a page-tall region still fits", () => {
        // A 1280 x 20000 screenshot in a 640 px high pane fits at 3.2%, under the 5% floor of the zoom buttons.
        const pane = { width: 1250, height: 640 };
        const canvas = { width: 1280, height: 20000 };
        const fit = resolveView(FIT_VIEW, pane, canvas).scale;
        expect(fit).toBe(0.032);

        const zoomOut = zoomViewBy({ view: FIT_VIEW, pane, canvas, factor: 1 / ZOOM_STEP });
        expect(resolveView(zoomOut, pane, canvas).scale).toBe(fit);
        const zoomIn = zoomViewBy({ view: FIT_VIEW, pane, canvas, factor: ZOOM_STEP });
        expect(resolveView(zoomIn, pane, canvas).scale).toBeCloseTo(fit * ZOOM_STEP);
        const page = { x: 0, y: 0, w: canvas.width, h: canvas.height };
        expect(viewForRect({ rect: page, pane, canvas }).scale).toBeLessThanOrEqual(fit);

        // A canvas that fits above 5% keeps the 5% floor.
        const short = { width: 1280, height: 2000 };
        const far = zoomViewBy({
            view: { scale: 0.06, cx: 640, cy: 1000 },
            pane,
            canvas: short,
            factor: 1 / ZOOM_STEP,
        });
        expect(far.scale).toBe(0.05);
    });

    test("the heat map takes coverage from where each image lies, not from its alpha", () => {
        const stops = [
            { r: 0, g: 0, b: 255 },
            { r: 255, g: 0, b: 0 },
        ];
        const white = (width: number, height: number) => solid({ width, height, rgb: WHITE });
        const clearAt = (image: RgbaImage, x: number, y: number): RgbaImage => {
            const data = new Uint8ClampedArray(image.data);
            data.set([0, 0, 0, 0], (y * image.width + x) * 4);

            return { ...image, data };
        };

        // Aligned: inside the overlap, opaque navy in A against a transparent pixel of B is a change.
        const a = solid({ width: 20, height: 10, rgb: WHITE, block: { x: 5, y: 5, w: 1, h: 1, rgb: NAVY } });
        const aligned = heatMap({ a, b: clearAt(white(20, 10), 7, 5), shift: { dx: 2, dy: 0 }, stops });
        expect({ changed: aligned.changed, total: aligned.total }).toEqual({ changed: 1, total: 180 });
        expect(aligned.data[(5 * 20 + 5) * 4 + 3]).toBeGreaterThan(0);

        // Unaligned, the same size: a transparent pixel blends over white, so against white it is no change.
        const unaligned = heatMap({ a: clearAt(white(4, 1), 1, 0), b: white(4, 1), shift: { dx: 0, dy: 0 }, stops });
        expect(unaligned.changed).toBe(0);

        // A row inside only one image is still the largest distance.
        expect(heatMap({ a: white(4, 1), b: white(4, 2), shift: { dx: 0, dy: 0 }, stops }).changed).toBe(4);
    });

    /** The first view of a canvas in a pane of this width, as ComparePane sizes it. */
    function firstView(canvas: CompareSize, width: number, maxHeight = 640) {
        const pane = { width, height: paneHeight({ canvas, width, maxHeight }) };

        return { pane, view: resolveView(FIT_VIEW, pane, canvas) };
    }

    function expectWhole(canvas: CompareSize, { pane, view }: ReturnType<typeof firstView>): void {
        expect(view.scale).toBeLessThanOrEqual(1);
        expect(view.y).toBe(0);
        expect(view.x).toBeGreaterThanOrEqual(0);
        expect(view.x + canvas.width * view.scale).toBeLessThanOrEqual(pane.width + 1e-9);
        expect(canvas.height * view.scale).toBeLessThanOrEqual(pane.height + 1e-9);
        // Centred across: the same space on both sides.
        expect(view.x).toBeCloseTo((pane.width - canvas.width * view.scale) / 2);
    }

    test("the first view shows the whole image, never above 100%, centred across with its top edge at the top", () => {
        // A 610 px screenshot in a 1250 px stage (slider, blink, fade, diff) and in a half-width side-by-side pane.
        const small = { width: 610, height: 900 };
        const wide = firstView(small, 1250);
        expect(wide.pane.height).toBe(640);
        expectWhole(small, wide);
        expectWhole(small, firstView(small, 617));
        expectWhole({ width: 610, height: 400 }, firstView({ width: 610, height: 400 }, 1250));
        expect(firstView({ width: 610, height: 400 }, 1250).view).toEqual({ scale: 1, x: 320, y: 0 });

        // A 1280 x 2000 page in a short stage, full width and side by side.
        const tall = { width: 1280, height: 2000 };
        const short = firstView(tall, 1250, 520);
        expect(short.view.scale).toBe(0.26);
        expectWhole(tall, short);
        expectWhole(tall, firstView(tall, 617, 520));

        // A pane taller than the fitted image still puts the image at the top.
        expectWhole(tall, {
            pane: { width: 400, height: 900 },
            view: resolveView(FIT_VIEW, { width: 400, height: 900 }, tall),
        });
    });

    test("100% from the first view keeps the top edge at the top and stays centred across when it fits", () => {
        const tall = { width: 1280, height: 2000 };
        const pane = { width: 1250, height: 640 };
        const actual = resolveView(actualSizeView(FIT_VIEW, pane, tall), pane, tall);
        expect(actual).toEqual({ scale: 1, x: -15, y: 0 });

        const small = { width: 610, height: 900 };
        expect(resolveView(actualSizeView(FIT_VIEW, pane, small), pane, small)).toEqual({ scale: 1, x: 320, y: 0 });
    });

    test("a view kept from a larger canvas is drawn inside the smaller canvas the pane now shows", () => {
        // Zoomed in at the foot of a 2000 px tall pair, then B is stepped to a pair only 900 px tall.
        const pane = { width: 400, height: 300 };
        const view = { scale: 1, cx: 200, cy: 1800 };
        expect(resolveView(view, pane, { width: 400, height: 900 })).toEqual({ scale: 1, x: 0, y: -600 });
        // In the canvas it was made for, the view is drawn as it is.
        expect(resolveView(view, pane, { width: 400, height: 2000 })).toEqual({ scale: 1, x: 0, y: -1650 });
    });

    test("an arrow key pans a tenth of the pane the way it points, half a pane with Shift, and other keys none", () => {
        const pane = { width: 600, height: 200 };
        expect(panKeyDelta({ key: "ArrowRight", shift: false, pane })).toEqual({ dx: -60, dy: 0 });
        expect(panKeyDelta({ key: "ArrowLeft", shift: false, pane })).toEqual({ dx: 60, dy: 0 });
        expect(panKeyDelta({ key: "ArrowDown", shift: false, pane })).toEqual({ dx: 0, dy: -20 });
        expect(panKeyDelta({ key: "ArrowUp", shift: true, pane })).toEqual({ dx: 0, dy: 100 });
        expect(panKeyDelta({ key: "a", shift: false, pane })).toBeUndefined();

        // ArrowDown shows what is below: the canvas point at the pane centre moves down.
        const down = panKeyDelta({ key: "ArrowDown", shift: false, pane }) ?? { dx: 0, dy: 0 };
        const view = { scale: 1, cx: 300, cy: 500 };
        expect(panView({ view, pane, canvas: { width: 600, height: 2000 }, ...down }).cy).toBe(520);
    });

    test("the active region follows a new diff only to the region at the same place", () => {
        const regions = [
            { x: 0, y: 80, w: 120, h: 20, pixels: 2400 },
            { x: 12, y: 30, w: 8, h: 6, pixels: 48 },
        ];
        expect(matchRegion(regions, { x: 12, y: 30, w: 8, h: 6 })).toBe(1);
        // A threshold change grew the box: the region over the old one's centre is still the one.
        expect(matchRegion(regions, { x: 13, y: 31, w: 5, h: 4 })).toBe(1);
        expect(matchRegion(regions, { x: 200, y: 200, w: 4, h: 4 })).toBe(-1);
        expect(matchRegion(regions, undefined)).toBe(-1);
    });

    test("a gutter with more numbers than it holds shows the active and the largest regions and counts the rest", () => {
        // Ten boxes down a 100 px pane: five 16 px marks fit 2 px apart, so four numbers and "+6".
        const pane = { width: 400, height: 100 };
        const canvas = { width: 400, height: 100 };
        const transform = { scale: 1, x: 0, y: 0 };
        const regions = Array.from({ length: 10 }, (_, i) => ({ x: 10, y: i * 10, w: 20, h: 4, pixels: 10 + i }));
        regions[7].pixels = 50;
        const { labels, more } = gutterLabels({ regions, transform, pane, canvas, active: 2 });

        // The active region, the largest (7), then the next largest (9 and 8), in box order.
        expect(labels.map((label) => label.index)).toEqual([2, 7, 8, 9]);
        expect(more).toEqual({ count: 6, top: 100 - GUTTER_LABEL_HEIGHT });
        const tops = [...labels.map((label) => label.top), more?.top ?? Number.NaN];

        for (let i = 1; i < tops.length; i++) {
            expect(tops[i] - tops[i - 1]).toBeGreaterThanOrEqual(GUTTER_LABEL_HEIGHT);
        }

        expect(tops.every((top) => top >= 0 && top + GUTTER_LABEL_HEIGHT <= pane.height)).toBe(true);

        // As many as fit: every number, no mark.
        const five = gutterLabels({ regions: regions.slice(0, 5), transform, pane, canvas });
        expect(five.labels.length).toBe(5);
        expect(five.more).toBeNull();

        // A 300 px pane with 18 boxes in view: every number needs 322 px, so 15 numbers and "+3", the active one kept.
        const tall = { width: 400, height: 300 };
        const many = Array.from({ length: 18 }, (_, i) => ({ x: 10, y: i * 16, w: 20, h: 4, pixels: 1 }));
        const crowded = gutterLabels({ regions: many, transform, pane: tall, canvas: tall, active: 17 });
        expect(crowded.labels.length).toBe(15);
        expect(crowded.labels.map((label) => label.index)).toContain(17);
        expect(crowded.more).toEqual({ count: 3, top: 300 - GUTTER_LABEL_HEIGHT });
        const crowdedTops = [...crowded.labels.map((label) => label.top), crowded.more?.top ?? Number.NaN];

        for (let i = 1; i < crowdedTops.length; i++) {
            expect(crowdedTops[i] - crowdedTops[i - 1]).toBeGreaterThanOrEqual(GUTTER_LABEL_HEIGHT);
        }

        expect(crowdedTops.every((top) => top >= 0 && top + GUTTER_LABEL_HEIGHT <= tall.height)).toBe(true);
        // Sixteen still fit (286 px): every number, no mark.
        const sixteen = gutterLabels({ regions: many.slice(0, 16), transform, pane: tall, canvas: tall });
        expect(sixteen.labels.length).toBe(16);
        expect(sixteen.more).toBeNull();
    });

    test("a leader leaves its box with a short tick and runs on only through the empty pane beside the image", () => {
        // A 200 px wide image centred in a 400 px pane spans x 100 to 300.
        const pane = { width: 400, height: 300 };
        const canvas = { width: 200, height: 300 };
        const regions = [
            { x: 20, y: 50, w: 30, h: 10, pixels: 1 },
            { x: 180, y: 150, w: 20, h: 10, pixels: 1 },
        ];
        const [inner, edge] = gutterLabels({ regions, transform: { scale: 1, x: 100, y: 0 }, pane, canvas }).labels;
        expect(inner.tick).toEqual([150, 150 + LEADER_TICK]);
        expect(inner.margin).toEqual([300, 400]);
        // A box at the image's right edge: its tick is already beside the image.
        expect(edge.tick).toEqual([300, 300 + LEADER_TICK]);
        expect(edge.margin).toEqual([300 + LEADER_TICK, 400]);

        // An image as wide as the pane leaves no empty pane: only the tick is drawn on it.
        const wide = gutterLabels({ regions, transform: { scale: 2, x: 0, y: 0 }, pane, canvas }).labels[0];
        expect(wide.tick).toEqual([100, 100 + LEADER_TICK]);
        expect(wide.margin).toBeNull();
    });

    test("region numbers sit in a gutter beside the stage, in box order, apart, inside, with a leader to each box", () => {
        const pane = { width: 400, height: 300 };
        const canvas = { width: 400, height: 300 };
        const transform = { scale: 1, x: 0, y: 0 };
        const box = (x: number, y: number, h = 10) => ({ x, y, w: 20, h, pixels: 1 });
        const regions = [box(10, 100), box(50, 102), box(90, 104), box(10, 600)];
        const { labels, more } = gutterLabels({ regions, transform, pane, canvas });

        // The fourth box is out of view, so it has no number in the gutter, and the three in view all fit.
        expect(labels.map((label) => label.index)).toEqual([0, 1, 2]);
        expect(more).toBeNull();

        for (let i = 1; i < labels.length; i++) {
            expect(labels[i].top - labels[i - 1].top).toBeGreaterThanOrEqual(GUTTER_LABEL_HEIGHT);
        }

        expect(labels.every((label) => label.top >= 0 && label.top + GUTTER_LABEL_HEIGHT <= pane.height)).toBe(true);
        // The leader starts at the box's right edge, half way down.
        expect(labels[0].anchor).toEqual({ x: 30, y: 105 });

        // A lone box gets its number level with it; a box at the bottom edge pulls its number inside the pane.
        const lone = gutterLabels({ regions: [box(10, 100)], transform, pane, canvas });
        expect(lone.labels[0].top).toBe(105 - GUTTER_LABEL_HEIGHT / 2);
        const low = gutterLabels({ regions: [box(0, 296, 4)], transform, pane, canvas });
        expect(low.labels[0].top).toBe(300 - GUTTER_LABEL_HEIGHT);

        // Zoomed in and panned, the anchor follows the box on screen.
        const zoomed = gutterLabels({
            regions: [box(10, 100)],
            transform: { scale: 2, x: -20, y: -150 },
            pane,
            canvas,
        });
        expect(zoomed.labels[0].anchor).toEqual({ x: 40, y: 60 });
    });

    /** A text-like page: bars of seeded lengths on white, drawn moved by `shift`. */
    function textPage({
        width,
        height,
        seed,
        shift = { dx: 0, dy: 0 },
    }: CompareSize & { seed: number; shift?: { dx: number; dy: number } }): RgbaImage {
        const data = new Uint8ClampedArray(width * height * 4).fill(255);
        let state = seed;
        const next = (): number => {
            state = (state * 1103515245 + 12345) % 2147483648;
            return state / 2147483648;
        };

        for (let line = 0; line * 14 + 16 < height; line++) {
            const top = 10 + line * 14 + shift.dy;
            const left = 12 + Math.floor(next() * 30) + shift.dx;
            const length = 20 + Math.floor(next() * (width - 80));

            for (let y = Math.max(0, top); y < Math.min(height, top + 7); y++) {
                for (let x = Math.max(0, left); x < Math.min(width, left + length); x++) {
                    data.set([40, 40, 48, 255], (y * width + x) * 4);
                }
            }
        }

        return { width, height, data };
    }

    /**
     * Seeded grey noise: no structure for a shift to lock onto. Each pixel is a hash of its index and the seed; one
     * running generator per image made two seeds the same sequence from another start, which is a real raster shift
     * that a 128 px window finds.
     */
    function noise({ width, height, seed }: CompareSize & { seed: number }): RgbaImage {
        const data = new Uint8ClampedArray(width * height * 4);

        for (let i = 0; i < width * height; i++) {
            let hash = Math.imul(i ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
            hash ^= hash >>> 13;
            hash = Math.imul(hash, 0xc2b2ae35);
            hash ^= hash >>> 16;
            const grey = hash & 255;
            data.set([grey, grey, grey, 255], i * 4);
        }

        return { width, height, data };
    }

    test("alignment finds a known shift, gives 0, 0 for an identical pair and no offset for unrelated pairs", () => {
        const a = textPage({ width: 220, height: 260, seed: 7 });
        const moved = textPage({ width: 220, height: 260, seed: 7, shift: { dx: 3, dy: 12 } });
        const shift = estimateShift(a, moved);

        expect(shift).toEqual({ dx: 3, dy: 12 });
        expect(estimateShift(a, textPage({ width: 220, height: 260, seed: 7, shift: { dx: -5, dy: -9 } }))).toEqual({
            dx: -5,
            dy: -9,
        });
        expect(estimateShift(a, a)).toEqual({ dx: 0, dy: 0 });
        expect(
            estimateShift(noise({ width: 200, height: 160, seed: 1 }), noise({ width: 200, height: 160, seed: 2 }))
        ).toBeNull();
        expect(estimateShift(a, textPage({ width: 220, height: 260, seed: 99 }))).toBeNull();
        expect(shiftText({ dx: 3, dy: 12 }, "After")).toBe("After is shifted by +3, +12 px");

        // On the aligned pair only the overlap is compared, and a pure move leaves nothing; unaligned, every text
        // line differs.
        const aligned = diffImages({ a, b: moved, threshold: 0.15, shift: { dx: 3, dy: 12 } });
        expect(aligned.size).toEqual({ width: 220, height: 260 });
        expect({ changed: aligned.changed, total: aligned.total }).toEqual({ changed: 0, total: 217 * 248 });
        expect(diffImages({ a, b: moved, threshold: 0.15 }).changed).toBeGreaterThan(1000);
    });

    test("a shift and a taller B: the strips the shift uncovered stay out, the rows only the taller image has count", () => {
        const a = textPage({ width: 220, height: 260, seed: 7 });
        const shift = { dx: 3, dy: 12 };
        // The same page 40 rows taller, moved 3 right and 12 down: 28 rows at the bottom exist only in B, as wide as
        // the overlap (217 px). The 3 columns on the right and B's 12 rows above the page are the shift's.
        const taller = textPage({ width: 220, height: 300, seed: 7, shift });
        const sizeOnly = 28 * 217;
        const diff = diffImages({ a, b: taller, threshold: 0.15, shift });

        expect({ changed: diff.changed, total: diff.total, sizeOnly: diff.sizeOnly }).toEqual({
            changed: sizeOnly,
            total: 217 * 260 + sizeOnly,
            sizeOnly,
        });
        expect(diff.regions).toEqual([{ x: 0, y: 260, w: 217, h: 28, pixels: sizeOnly }]);
        expect(comparedAreaText(diff)).toBe(
            " on the aligned pair: where both overlap, plus the 6,076 pixels only one image has because the sizes differ,"
        );

        const stops = [
            { r: 0, g: 0, b: 255 },
            { r: 255, g: 0, b: 0 },
        ];
        const heat = heatMap({ a, b: taller, shift, stops });
        expect({ changed: heat.changed, total: heat.total, sizeOnly: heat.sizeOnly }).toEqual({
            changed: sizeOnly,
            total: 217 * 260 + sizeOnly,
            sizeOnly,
        });

        // Equal sizes: only the shift's strips are outside the overlap, and they stay out.
        const moved = diffImages({
            a,
            b: textPage({ width: 220, height: 260, seed: 7, shift }),
            threshold: 0.15,
            shift,
        });
        expect({ changed: moved.changed, sizeOnly: moved.sizeOnly }).toEqual({ changed: 0, sizeOnly: 0 });
        expect(comparedAreaText(moved)).toBe(" on the aligned pair, where both overlap,");
        expect(comparedAreaText(diffImages({ a, b: taller, threshold: 0.15 }))).toBe("");

        // B shorter than A and moved up 5: A's rows past what B could show at A's height count, the 5 rows the move
        // uncovered at the top do not.
        const shorter = textPage({ width: 220, height: 240, seed: 7, shift: { dx: 0, dy: -5 } });
        const up = diffImages({ a, b: shorter, threshold: 0.15, shift: { dx: 0, dy: -5 } });
        expect(up.sizeOnly).toBe((260 - 245) * 220);
    });

    test("the default alignment window finds a page moved down 48 px by a taller banner", () => {
        const a = textPage({ width: 220, height: 260, seed: 7 });

        expect(estimateShift(a, textPage({ width: 220, height: 260, seed: 7, shift: { dx: 0, dy: 48 } }))).toEqual({
            dx: 0,
            dy: 48,
        });
        expect(estimateShift(a, textPage({ width: 220, height: 260, seed: 7, shift: { dx: 2, dy: -40 } }))).toEqual({
            dx: 2,
            dy: -40,
        });
    });

    test("alignment sees one-pixel rules on odd rows and odd columns, so a one-pixel move of thin lines is found", () => {
        /** One-pixel rules of varied lengths on odd rows (`across`) or odd columns, moved `move` px along the rule. */
        const rules = ({ across, move }: { across: boolean; move: number }): RgbaImage => {
            const size = 200;
            const data = new Uint8ClampedArray(size * size * 4).fill(255);

            for (let line = 0; line < 30; line++) {
                const start = 10 + ((line * 37) % 29) + move;
                const at = 1 + line * 4;

                for (let i = start; i < start + 40 + ((line * 53) % 90); i++) {
                    data.set([40, 40, 48, 255], ((across ? at : i) * size + (across ? i : at)) * 4);
                }
            }

            return { width: size, height: size, data };
        };

        // The candidates 0 and 1 differ by one pixel; both must be compared on the rows and columns that hold the rules.
        expect(estimateShift(rules({ across: true, move: 0 }), rules({ across: true, move: 1 }))).toEqual({
            dx: 1,
            dy: 0,
        });
        expect(estimateShift(rules({ across: false, move: 0 }), rules({ across: false, move: 1 }))).toEqual({
            dx: 0,
            dy: 1,
        });
    });

    test("the pane is never shorter than its CSS minimum, so zoom and pan work on the pane the user sees", () => {
        // A 120 x 40 image fits at 40 px and a maxHeight of 50 caps a tall image at 50, but the pane is 96 px tall.
        expect(PANE_MIN_HEIGHT).toBe(96);
        expect(paneHeight({ canvas: { width: 120, height: 40 }, width: 600, maxHeight: 640 })).toBe(PANE_MIN_HEIGHT);
        expect(paneHeight({ canvas: { width: 800, height: 600 }, width: 600, maxHeight: 50 })).toBe(PANE_MIN_HEIGHT);
        expect(paneHeight({ canvas: { width: 800, height: 600 }, width: 600, maxHeight: 640 })).toBe(450);
    });

    /**
     * The gallery's dashboard drawn without a canvas: a white header with a title and a button, three cards with a
     * label and a value, and a chart panel with a line of dots on a light grey page. Text is drawn as glyph-like
     * strokes, one pattern per character, because the column profile of a real page is mostly its text. `after`
     * makes the gallery's real changes (the button moves 14 px, turns green and gets a new label, two values change,
     * one chart point jumps) and `shift` moves the whole page, as the gallery's "A shifted image" does.
     */
    function dashboard({ after, shift }: { after: boolean; shift: { dx: number; dy: number } }): RgbaImage {
        const width = 720;
        const height = 400;
        const data = new Uint8ClampedArray(width * height * 4);
        const fill = (x: number, y: number, w: number, h: number, rgb: [number, number, number]): void => {
            for (let row = Math.max(0, y + shift.dy); row < Math.min(height, y + h + shift.dy); row++) {
                for (let col = Math.max(0, x + shift.dx); col < Math.min(width, x + w + shift.dx); col++) {
                    data.set([...rgb, 255], (row * width + col) * 4);
                }
            }
        };

        for (let i = 0; i < width * height; i++) {
            data.set([244, 245, 247, 255], i * 4);
        }

        /** Each character is a 10 px cell with one or two strokes placed by its code, so another string changes columns. */
        const text = (x: number, y: number, value: string, size: number, rgb: [number, number, number]): void => {
            [...value].forEach((char, index) => {
                const code = char.charCodeAt(0);
                const left = x + index * Math.round(size * 0.62);
                fill(left + (code % 5), y, 2, size, rgb);

                if (code % 3 === 0) {
                    fill(left, y + Math.round(size / 2), Math.round(size * 0.5), 2, rgb);
                }

                if (code % 2 === 0) {
                    fill(left + 2 + (code % 4), y, 2, Math.round(size / 2), rgb);
                }
            });
        };
        const ink: [number, number, number] = [29, 35, 48];
        const dim: [number, number, number] = [107, 115, 133];
        const white: [number, number, number] = [255, 255, 255];
        fill(0, 0, width, 52, white);
        fill(0, 52, width, 1, [217, 220, 227]);
        text(20, 18, "Bookings", 17, ink);
        fill(width - (after ? 150 : 164), 12, 128, 30, after ? [31, 157, 107] : [47, 111, 236]);
        text(width - (after ? 132 : 146), 20, after ? "New booking" : "Add booking", 13, white);
        const cardWidth = (width - 80) / 3;
        const cards = [
            ["Today", after ? "1,312" : "1,284"],
            ["This week", "8,940"],
            ["No-shows", after ? "2.1%" : "3.4%"],
        ];

        cards.forEach(([label, value], card) => {
            const left = Math.round(20 + card * (cardWidth + 20));
            fill(left, 72, Math.round(cardWidth), 96, white);
            text(left + 16, 90, label, 13, dim);
            text(left + 16, 118, value, 28, ink);
        });

        fill(20, 188, width - 40, 160, white);

        for (let step = 0; step <= 12; step++) {
            const x = Math.round(40 + ((width - 80) * step) / 12);
            const bump = after && step === 8 ? 38 : 0;
            const y = Math.round(188 + 120 - 50 * Math.abs(Math.sin(step / 2.2)) - bump);
            fill(x - 3, y - 3, 6, 6, [47, 111, 236]);
        }

        return { width, height, data };
    }

    test("alignment finds a page shift that comes with a few real changes, as in the gallery's shifted case", () => {
        const before = dashboard({ after: false, shift: { dx: 0, dy: 0 } });
        const moved = dashboard({ after: true, shift: { dx: 3, dy: 12 } });

        expect(estimateShift(before, moved)).toEqual({ dx: 3, dy: 12 });
        // The real changes alone are no shift.
        expect(estimateShift(before, dashboard({ after: true, shift: { dx: 0, dy: 0 } }))).toEqual({ dx: 0, dy: 0 });

        // Aligned, the diff is the real changes only: the strips the move uncovered are the shift, not changes, so
        // no region is the whole page.
        const realOnly = diffImages({
            a: before,
            b: dashboard({ after: true, shift: { dx: 0, dy: 0 } }),
            threshold: 0.15,
        });
        const aligned = diffImages({ a: before, b: moved, threshold: 0.15, shift: { dx: 3, dy: 12 } });
        expect(aligned.changed).toBeGreaterThan(0);
        expect(aligned.changed).toBeLessThanOrEqual(realOnly.changed);
        expect(aligned.regions.every((region) => region.w < 700 && region.h < 380)).toBe(true);
    });

    test("the comparison keys pick a mode by number, zoom, fit and step image B", () => {
        expect(compareKey("1")).toEqual({ kind: "mode", index: 0 });
        expect(compareKey("6")).toEqual({ kind: "mode", index: 5 });
        expect(compareKey("+")).toEqual({ kind: "zoom", factor: 1.25 });
        expect(compareKey("=")).toEqual({ kind: "zoom", factor: 1.25 });
        expect(compareKey("-")).toEqual({ kind: "zoom", factor: 0.8 });
        expect(compareKey("0")).toEqual({ kind: "fit" });
        expect(compareKey("]")).toEqual({ kind: "step-b", by: 1 });
        expect(compareKey("[")).toEqual({ kind: "step-b", by: -1 });
        expect(compareKey("a")).toBeUndefined();
        expect(compareKey(" ")).toBeUndefined();
    });
});
