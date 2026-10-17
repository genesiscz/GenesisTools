import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@genesiscz/utils/json";
import { act } from "react";
import { tabHash, tabIdFromHash } from "./data";
import { composeHash, isChartSegment, plainSegment, withPlainSegment } from "./hash";
import { mountDom } from "./test-dom";
import { TimeSeries, type TsSeries } from "./timeseries";
import {
    assignPanels,
    clampRange,
    clusterMarkers,
    DAY,
    decimate,
    decodeViewState,
    emptyViewState,
    encodeViewState,
    formatDurationShort,
    HOUR,
    laneGutterWidth,
    layoutLanes,
    layoutLanesIn,
    localParts,
    logScale,
    MINUTE,
    nearestIndex,
    niceScale,
    orderPanels,
    packRows,
    plainText,
    planMarkerLines,
    readHashState,
    stackPoints,
    stripTags,
    type TsPoint,
    timeTicks,
    toCsv,
    tzOffset,
    type ValueScale,
    valueAt,
    visibleMarkerKinds,
    writeHashState,
    zoomRange,
} from "./timeseries-core";

const T0 = Date.UTC(2026, 9, 10, 0, 0, 0);

/** A climb of one unit per minute with one sharp drop to zero at minute `dropAt`. */
function sawtooth(n: number, dropAt: number): TsPoint[] {
    return Array.from({ length: n }, (_, i): TsPoint => [T0 + i * MINUTE, i === dropAt ? 0 : i]);
}

describe("decimate", () => {
    test("returns raw points (plus one neighbour per side) when they fit the width", () => {
        const pts = sawtooth(100, -1);
        const out = decimate(pts, pts[10][0], pts[20][0], 50);

        expect(out[0]).toEqual(pts[9]);
        expect(out[out.length - 1]).toEqual(pts[21]);
        expect(out).toHaveLength(13);
    });

    test("keeps a one-sample drop visible at any zoom", () => {
        const pts = sawtooth(20_000, 12_345);
        const out = decimate(pts, pts[0][0], pts[pts.length - 1][0], 300);

        expect(out.length).toBeLessThanOrEqual(300 * 4 + 2);
        expect(out.some(([t, v]) => t === pts[12_345][0] && v === 0)).toBe(true);
        expect(Math.max(...out.map(([, v]) => v ?? 0))).toBe(19_999);
    });

    test("a null in dense data survives as a gap", () => {
        const pts = sawtooth(5_000, -1);
        pts[2_500] = [pts[2_500][0], null];
        const out = decimate(pts, pts[0][0], pts[4_999][0], 100);

        expect(out.some(([t, v]) => t === pts[2_500][0] && v === null)).toBe(true);
    });
});

describe("search", () => {
    const pts: TsPoint[] = [
        [0, 1],
        [10, null],
        [20, 3],
    ];

    test("nearestIndex skips nulls and honours the max distance", () => {
        expect(nearestIndex(pts, 9)).toBe(0);
        expect(nearestIndex(pts, 16)).toBe(2);
        expect(nearestIndex(pts, 10, 4)).toBe(-1);
    });

    test("valueAt is the step value", () => {
        expect(valueAt(pts, -1)).toBeNull();
        expect(valueAt(pts, 5)).toBe(1);
        expect(valueAt(pts, 25)).toBe(3);
    });
});

describe("range math", () => {
    const bounds: [number, number] = [0, 1000];
    const minSpan = 1;

    test("clamp keeps the span inside the bounds and above the minimum", () => {
        expect(clampRange([-50, 50], { bounds, minSpan })).toEqual([0, 100]);
        expect(clampRange([950, 1100], { bounds, minSpan })).toEqual([850, 1000]);
        expect(clampRange([-10, 5000], { bounds, minSpan })).toEqual([0, 1000]);
        expect(clampRange([500, 500.5], { bounds, minSpan: 10 })).toEqual([500, 510]);
    });

    test("zoom keeps the anchor under the cursor", () => {
        const out = zoomRange([200, 600], { factor: 0.5, anchor: 300, bounds, minSpan });

        expect(out).toEqual([250, 450]);
        expect(zoomRange([200, 600], { factor: 10, bounds, minSpan })).toEqual([0, 1000]);
    });
});

describe("ticks", () => {
    test("time ticks align on the local wall clock of the time zone", () => {
        const ticks = timeTicks({ range: [T0, T0 + 6 * HOUR], width: 600, timeZone: "Europe/Prague" });

        expect(ticks.length).toBeGreaterThan(2);
        expect(ticks.every((t) => /^\d\d:00$/.test(t.label) || t.major)).toBe(true);
        // T0 is 00:00 UTC = 02:00 in Prague (summer time), so no tick falls on a Prague midnight.
        expect(ticks.some((t) => t.major)).toBe(false);
        expect(tzOffset(T0, "Europe/Prague")).toBe(2 * HOUR);
    });

    test("ticks switch from seconds to days as the span grows", () => {
        const short = timeTicks({ range: [T0 + HOUR, T0 + HOUR + 2 * MINUTE], width: 800, timeZone: "UTC" });
        const long = timeTicks({ range: [T0, T0 + 20 * DAY], width: 800, timeZone: "UTC" });

        expect(short[0].label).toMatch(/^\d\d:\d\d:\d\d$/);
        expect(long[0].label).toMatch(/^\d+ [A-Z][a-z]{2}$/);
    });

    test("nice value scale covers the data with round ticks", () => {
        expect(niceScale(0, 100, 4)).toEqual({ min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
        expect(niceScale(3, 3).ticks.length).toBeGreaterThan(1);
    });

    test("short durations never print 24h", () => {
        expect(formatDurationShort(10 * DAY - 1000)).toBe("9d 23h");
        expect(formatDurationShort(90 * MINUTE)).toBe("1h 30m");
    });
});

describe("lanes, markers, stacks, panels", () => {
    test("packRows puts overlapping spans on separate rows and reuses free rows", () => {
        expect(
            packRows([
                { start: 0, end: 10 },
                { start: 5, end: 15 },
                { start: 11, end: 20 },
            ])
        ).toEqual([0, 1, 0]);
    });

    test("layoutLanes groups by lane and puts unnamed spans last", () => {
        const lanes = layoutLanes([
            { start: 0, end: 5 },
            { start: 0, end: 5, lane: "agents" },
            { start: 1, end: 5, lane: "agents" },
        ]);

        expect(lanes.map((l) => [l.name, l.rows])).toEqual([
            ["agents", 2],
            ["Other", 1],
        ]);
    });

    test("layoutLanesIn packs only the spans in view and keeps every lane in order", () => {
        const spans = [
            { start: 0, end: 10, lane: "a" },
            { start: 1, end: 10, lane: "a" },
            { start: 2, end: 10, lane: "a" },
            { start: 50, end: 60, lane: "a" },
            { start: 0, end: 5, lane: "b" },
        ];
        const all = layoutLanesIn(spans, [0, 100], ["a", "b"]);
        const late = layoutLanesIn(spans, [40, 100], ["a", "b"]);

        expect(all.map((l) => l.rows)).toEqual([3, 1]);
        expect(late.map((l) => [l.name, l.rows, l.items])).toEqual([
            ["a", 1, [3]],
            ["b", 1, []],
        ]);
    });

    test("laneGutterWidth fits the longest name within its bounds", () => {
        expect(laneGutterWidth(["a"])).toBe(76);
        expect(laneGutterWidth(["subagents: opus"])).toBeGreaterThan(76);
        expect(laneGutterWidth(["x".repeat(200)])).toBe(180);
    });

    test("clusterMarkers merges markers closer than the gap", () => {
        const clusters = clusterMarkers([0, 5, 9, 40, 100, 104], 10);

        expect(clusters.map((c) => c.items)).toEqual([[0, 1, 2], [3], [4, 5]]);
    });

    test("round 3: stacked geometry includes asynchronous lower-layer changes", () => {
        const layers = stackPoints([
            [
                [0, 10],
                [10, 20],
            ],
            [
                [5, 1],
                [15, 2],
            ],
        ]);
        expect(layers[0].top).toEqual([
            [0, 10],
            [5, 10],
            [10, 20],
            [15, 20],
        ]);
        expect(layers[1].top).toEqual([
            [0, null],
            [5, 11],
            [10, 21],
            [15, 22],
        ]);
        expect(layers[1].base).toEqual([
            [0, 10],
            [5, 10],
            [10, 20],
            [15, 20],
        ]);
        expect(valueAt(layers[1].top, 10)).toBe(21);
    });

    test("round 3: stacked gaps remain gaps and hold their left edge until the gap starts", () => {
        const layers = stackPoints([
            [
                [0, 10],
                [10, null],
                [20, 5],
            ],
            [
                [0, 1],
                [5, null],
                [15, 2],
                [25, 3],
            ],
        ]);
        expect(layers[1].top).toContainEqual([10, null]);
        expect(valueAt(layers[1].top, 10)).toBeNull();
        expect(layers[1].top).toContainEqual([5, 11]);
        expect(layers[1].top).toContainEqual([5, null]);
        expect(layers[1].top).toContainEqual([20, 7]);
        expect(layers[1].base).toContainEqual([20, 5]);
    });

    test("stackPoints adds the lower layer's step value", () => {
        const [, top] = stackPoints([
            [
                [0, 10],
                [10, 20],
            ],
            [
                [5, 1],
                [15, 2],
            ],
        ]);

        expect(top.top).toEqual([
            [0, null],
            [5, 11],
            [10, 21],
            [15, 22],
        ]);
    });

    test("assignPanels: combined holds two units per panel, split follows the group", () => {
        const series = [
            { id: "a", unit: "tokens" },
            { id: "b", unit: "usd" },
            { id: "c", unit: "%" },
            { id: "d", unit: "tokens", group: "cache" },
        ];

        expect(assignPanels(series, "combined").map((p) => p.axes.map((a) => a.unit))).toEqual([
            ["tokens", "usd"],
            ["%"],
        ]);
        expect(assignPanels(series, "split").map((p) => p.key)).toEqual(["tokens", "usd", "%", "cache"]);
    });
});

describe("split rework: text, marker kinds, group order", () => {
    test("stripTags removes XML and HTML-looking tags and comments but keeps text and line breaks", () => {
        const raw =
            "<task-notification>\n  <status>done</status>\n</task-notification>\nRan <b>3</b> &amp; ok <!-- x -->";

        expect(stripTags(raw)).toBe("done\nRan 3 & ok");
        expect(stripTags("a < b and c > d")).toBe("a < b and c > d");
    });

    test("plainText collapses whitespace into one line", () => {
        expect(plainText("<p>one</p>\n\n  two\tthree")).toBe("one two three");
    });

    test("visibleMarkerKinds: the viewer's choice wins, then the initial list, then every kind", () => {
        const kinds = ["prompt", "compaction", "wake"];

        expect([...visibleMarkerKinds(kinds, undefined, {})]).toEqual(kinds);
        expect([...visibleMarkerKinds(kinds, ["prompt", "compaction"], {})]).toEqual(["prompt", "compaction"]);
        expect([...visibleMarkerKinds(kinds, ["prompt"], { wake: true, prompt: false })]).toEqual(["wake"]);
        expect(visibleMarkerKinds(kinds, [], {}).size).toBe(0);
    });

    test("orderPanels follows the groups list and keeps unlisted groups after it in their order", () => {
        const panels = [{ group: "cost" }, { group: "context" }, { group: "extra" }, { group: "cache" }];

        expect(orderPanels(panels, ["context", "cache"]).map((p) => p.group)).toEqual([
            "context",
            "cache",
            "cost",
            "extra",
        ]);
        expect(
            assignPanels(
                [
                    { id: "a", unit: "usd", group: "cost" },
                    { id: "b", unit: "tokens", group: "context" },
                ],
                "split",
                ["context"]
            ).map((p) => p.key)
        ).toEqual(["context", "cost"]);
    });

    test("planMarkerLines: sparse views keep lines, dense views only tick, forced markers always keep theirs", () => {
        const sparse = [
            { x: 10, items: [0] },
            { x: 50, items: [1, 2, 3] },
        ];

        expect(planMarkerLines(sparse, [false, false, false, false])).toEqual({ full: [0], faint: [50], ticks: [] });

        const dense = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, items: [i] }));
        const forced = dense.map((_, i) => i === 7);
        const plan = planMarkerLines(dense, forced);

        expect(plan.full).toEqual([7]);
        expect(plan.faint).toEqual([]);
        expect(plan.ticks).toHaveLength(40);
    });

    test("a cluster never draws one line per member", () => {
        const plan = planMarkerLines([{ x: 5, items: [0, 1, 2, 3, 4] }], [false, true, false, false, false]);

        expect(plan.full).toEqual([1]);
        expect(plan.faint).toEqual([5]);
    });

    test("the old hidden-markers form still decodes", () => {
        expect(decodeViewState("m=wake%2Cprompt").markers).toEqual({ wake: false, prompt: false });
    });
});

describe("csv and state", () => {
    test("toCsv writes one row per time with blanks for missing samples", () => {
        const csv = toCsv(
            [
                { label: "a", points: [[0, 1]] },
                {
                    label: "b, quoted",
                    points: [
                        [0, 2],
                        [1000, 3],
                    ],
                },
            ],
            [0, 1000]
        );

        expect(csv).toBe('time,a,"b, quoted"\n1970-01-01T00:00:00.000Z,1,2\n1970-01-01T00:00:01.000Z,,3\n');
    });

    test("view state round-trips through the encoded form and the hash", () => {
        const state = {
            ...emptyViewState(),
            series: { "a,b": true, c: false },
            layout: "split" as const,
            range: [100, 200] as [number, number],
            log: ["tokens"],
            normalize: true,
            markers: { wake: false, prompt: true },
            allValues: true,
            lanesOpen: false,
        };
        const encoded = encodeViewState(state);

        expect(decodeViewState(encoded)).toEqual(state);

        const hash = writeHashState("#ts.other=x", "main", encoded);

        expect(hash).toContain("ts.other=x");
        expect(readHashState(hash ?? "", "main")).toBe(encoded);
        expect(writeHashState("#overview", "main", encoded)).toBe(`#overview&ts.main=${encodeURIComponent(encoded)}`);
    });
});

describe("shared URL hash (Tabs + charts)", () => {
    test("chart segments are recognised by their ts.<id>= prefix only", () => {
        expect(isChartSegment("ts.ctx=r%3D1")).toBe(true);
        expect(isChartSegment("ts.ctx")).toBe(false);
        expect(isChartSegment("misses")).toBe(false);
    });

    test("compose puts the plain segment first and keeps chart order", () => {
        expect(composeHash(["ts.a=1", "misses", "ts.b=2"])).toBe("#misses&ts.a=1&ts.b=2");
        expect(composeHash([])).toBe("");
        expect(plainSegment("#ts.a=1&my%20tab&ts.b=2")).toBe("my%20tab");
        expect(withPlainSegment("#old&ts.a=1", "")).toBe("#ts.a=1");
    });

    test("a tab write keeps every chart segment and a chart write keeps the tab", () => {
        const withCharts = writeHashState(writeHashState("", "a", "r=1~2"), "b", "l=split");
        const tabbed = tabHash("misses", withCharts);

        expect(tabIdFromHash(tabbed)).toBe("misses");
        expect(readHashState(tabbed, "a")).toBe("r=1~2");
        expect(readHashState(tabbed, "b")).toBe("l=split");

        const rewritten = writeHashState(tabbed, "a", "r=3~4");

        expect(tabIdFromHash(rewritten)).toBe("misses");
        expect(readHashState(rewritten, "a")).toBe("r=3~4");
        expect(tabHash("other", rewritten)).toBe(rewritten.replace("#misses", "#other"));
    });

    test("a hash with only chart segments carries no tab id", () => {
        expect(tabIdFromHash("#ts.a=1")).toBe("");
        expect(tabIdFromHash("#misses")).toBe("misses");
        expect(tabHash("my tab")).toBe("#my%20tab");
    });
});

describe("TimeSeries render", () => {
    test("a chart with spans and no series renders as an activity timeline with a compact menu", async () => {
        const dom = await mountDom(
            <TimeSeries
                series={[]}
                markers={[
                    { t: T0, label: "go", kind: "prompt" },
                    { t: T0 + MINUTE, label: "c", kind: "compaction" },
                ]}
                markerKinds={["prompt"]}
                spans={[{ start: T0, end: T0 + 10 * MINUTE, label: "agent", kind: "agent", lane: "agents" }]}
            />
        );
        const buttons = [...dom.container.querySelectorAll("button")];
        const kindButton = (k: string) => buttons.find((b) => b.textContent?.startsWith(k));

        expect(kindButton("prompt")?.getAttribute("aria-pressed")).toBe("true");
        expect(kindButton("compaction")?.getAttribute("aria-pressed")).toBe("false");
        expect(buttons.some((b) => b.textContent === "Split")).toBe(false);

        await dom.click(buttons.find((b) => b.textContent === "⋯"));

        expect(dom.container.querySelector("[role=menu]")?.textContent).toContain("PNG");

        await dom.unmount();
    });

    test("round 1: copied links preserve file and HTTP URLs, query, tab and sibling chart state", async () => {
        for (const href of [
            "file:///tmp/report.html?page=time-series#overview&ts.other=keep&ts.main=l%3Dsplit",
            "https://example.com/report?page=time-series#overview&ts.other=keep&ts.main=l%3Dsplit",
        ]) {
            const dom = await mountDom(<TimeSeries id="main" series={[]} layout="split" />, href);
            const copied: string[] = [];
            Object.defineProperty(dom.window.navigator, "clipboard", {
                configurable: true,
                value: {
                    writeText: async (value: string) => {
                        copied.push(value);
                    },
                },
            });
            await dom.click([...dom.container.querySelectorAll("button")].find((b) => b.textContent === "⋯"));
            await dom.click([...dom.container.querySelectorAll("button")].find((b) => b.textContent === "Link"));
            expect(copied).toHaveLength(1);
            const url = new URL(copied[0]);
            const original = new URL(href);
            expect([url.protocol, url.pathname, url.search]).toEqual([
                original.protocol,
                original.pathname,
                original.search,
            ]);
            expect(tabIdFromHash(url.hash)).toBe("overview");
            expect(readHashState(url.hash, "other")).toBe("keep");
            expect(readHashState(url.hash, "main")).toBe("l=split");
            await dom.unmount();
        }
    });

    test("round 3: renderer draws stacked areas as steps and keeps bars at their own sample times", async () => {
        const dom = await mountDom(<p>canvas harness</p>);
        const strokes: Array<{ color: string; points: Array<[number, number]> }> = [];
        const rectangles: string[] = [];
        let path: Array<[number, number]> = [];
        const context = new Proxy(
            {
                fillStyle: "",
                strokeStyle: "",
                beginPath: () => {
                    path = [];
                },
                moveTo: (x: number, y: number) => {
                    path.push([x, y]);
                },
                lineTo: (x: number, y: number) => {
                    path.push([x, y]);
                },
                stroke() {
                    strokes.push({ color: this.strokeStyle, points: path.slice() });
                },
                fillRect() {
                    rectangles.push(this.fillStyle);
                },
                measureText: () => ({ width: 30 }),
            },
            {
                get(target, key, receiver) {
                    return Reflect.has(target, key) ? Reflect.get(target, key, receiver) : () => undefined;
                },
            }
        );
        Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
            configurable: true,
            value: () => context,
        });
        Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
        const series: TsSeries[] = [
            {
                id: "lower",
                label: "Lower",
                color: "#123456",
                stack: "load",
                points: [
                    [T0, 10],
                    [T0 + 10 * MINUTE, 20],
                ],
            },
            {
                id: "upper",
                label: "Upper",
                color: "#abcdef",
                stack: "load",
                points: [
                    [T0 + 5 * MINUTE, 1],
                    [T0 + 15 * MINUTE, 2],
                ],
            },
        ];
        await dom.render(<TimeSeries series={series.map((s) => ({ ...s, kind: "area" }))} brush={false} />);
        const upper = strokes.find((stroke) => stroke.color === "#abcdef");
        expect(upper?.points).toHaveLength(5);
        for (let i = 1; i < (upper?.points.length ?? 0); i += 1) {
            const previous = upper?.points[i - 1];
            const current = upper?.points[i];
            expect(previous?.[0] === current?.[0] || previous?.[1] === current?.[1]).toBe(true);
        }
        rectangles.length = 0;
        await dom.render(<TimeSeries series={series.map((s) => ({ ...s, kind: "bar" }))} brush={false} />);
        expect(rectangles.filter((color) => color === "#123456")).toHaveLength(2);
        expect(rectangles.filter((color) => color === "#abcdef")).toHaveLength(2);
        await dom.unmount();
    });

    test("renders chips and toggles, and the layout switch updates", async () => {
        const series = [
            { id: "ctx", label: "Context", unit: "tokens", points: sawtooth(50, 30) },
            { id: "cost", label: "Cost", unit: "usd", points: sawtooth(50, -1), hidden: true },
        ];
        const dom = await mountDom(
            <TimeSeries
                title="Smoke"
                series={series}
                markers={[{ t: T0 + 30 * MINUTE, label: "Compaction", kind: "compaction" }]}
                spans={[{ start: T0, end: T0 + 10 * MINUTE, label: "agent", kind: "agent", lane: "agents" }]}
            />
        );
        const chip = (label: string) =>
            [...dom.container.querySelectorAll("button[aria-pressed]")].find((b) => b.textContent?.startsWith(label));

        expect(dom.container.querySelector("[role=group]")?.getAttribute("aria-label")).toContain("1 of 2 series");
        expect(chip("Context")?.getAttribute("aria-pressed")).toBe("true");
        expect(chip("Cost")?.getAttribute("aria-pressed")).toBe("false");

        await dom.click(chip("Cost"));

        expect(chip("Cost")?.getAttribute("aria-pressed")).toBe("true");

        const split = dom.container.querySelector("[role=radio][aria-checked=false]");
        await dom.click(split);

        expect(split?.getAttribute("aria-checked")).toBe("true");

        await dom.click([...dom.container.querySelectorAll("button")].find((b) => b.textContent === "Table"));

        expect(dom.html()).toContain("rows in view");

        await dom.unmount();
    });
});

describe("round 4 long-range ticks", () => {
    test("quarterly ticks cover the final year of a multi-year viewport", () => {
        const ticks = timeTicks({
            range: [Date.parse("2026-02-15T12:00:00Z"), Date.parse("2029-03-31T21:00:00Z")],
            width: 1800,
            timeZone: "Europe/Prague",
        });
        expect(ticks.map((tick) => tick.label)).toEqual([
            "Apr 2026",
            "Jul 2026",
            "Oct 2026",
            "Jan 2027",
            "Apr 2027",
            "Jul 2027",
            "Oct 2027",
            "Jan 2028",
            "Apr 2028",
            "Jul 2028",
            "Oct 2028",
            "Jan 2029",
        ]);
        expect(ticks.every((tick) => localParts(tick.t, "Europe/Prague").hour === 0)).toBe(true);
    });

    test("yearly ticks use January boundaries through the entire twelve-year viewport", () => {
        const ticks = timeTicks({
            range: [Date.parse("2026-06-15T00:00:00Z"), Date.parse("2038-06-15T00:00:00Z")],
            width: 1200,
            timeZone: "UTC",
        });
        expect(ticks.map((tick) => tick.label)).toEqual(
            Array.from({ length: 12 }, (_, index) => `Jan ${2027 + index}`)
        );
    });
});

describe("round 5 logarithmic boundaries", () => {
    test("subnormal and maximum finite log ranges finish with finite ordered ticks", async () => {
        const ranges = [
            [Number.MIN_VALUE, 1],
            [1, Number.MAX_VALUE],
            [Number.MIN_VALUE, Number.MIN_VALUE],
            [Number.MAX_VALUE, Number.MAX_VALUE],
            [1e308, 1.1e308],
            [1e-320, 1e-319],
            [1e-6, 1e-5],
            [Number.MIN_VALUE, Number.MAX_VALUE],
            // Just above 1e-300, Math.log10 rounds down, so 10 ** ceil(log10(max)) lands below max without the upper step.
            [1e-301, 1.0000000000000002e-300],
        ];
        const probe = Bun.spawn(
            [
                process.execPath,
                "--eval",
                `
            import { logScale } from ${SafeJSON.stringify(new URL("./timeseries-core.ts", import.meta.url).pathname)};
            import { SafeJSON } from ${SafeJSON.stringify(new URL("../../../utils/json.ts", import.meta.url).pathname)};
            console.log(SafeJSON.stringify(${SafeJSON.stringify(ranges)}.map(([lo, hi]) => logScale(lo, hi))));
        `,
            ],
            { stdout: "pipe", stderr: "pipe", env: process.env }
        );
        const deadline = setTimeout(() => probe.kill(), 2000);
        try {
            const [exitCode, stdout, stderr] = await Promise.all([
                probe.exited,
                new Response(probe.stdout).text(),
                new Response(probe.stderr).text(),
            ]);
            expect(stderr).toBe("");
            expect(exitCode, "logScale boundary probe must finish before its deadline").toBe(0);
            const scales: ValueScale[] = SafeJSON.parse(stdout);
            expect(scales).toHaveLength(ranges.length);
            for (const [index, scale] of scales.entries()) {
                expect(Number.isFinite(scale.min) && scale.min > 0).toBe(true);
                expect(Number.isFinite(scale.max) && scale.max > scale.min).toBe(true);
                expect(scale.min).toBeLessThanOrEqual(ranges[index][0]);
                expect(scale.max).toBeGreaterThanOrEqual(ranges[index][1]);
                expect(scale.ticks.length).toBeGreaterThan(0);
                expect(scale.ticks.length).toBeLessThanOrEqual(634);
                expect(
                    scale.ticks.every(
                        (tick, at) =>
                            Number.isFinite(tick) &&
                            tick >= scale.min &&
                            tick <= scale.max &&
                            (at === 0 || tick > scale.ticks[at - 1])
                    )
                ).toBe(true);
            }
        } finally {
            clearTimeout(deadline);
            probe.kill();
        }
    });

    test("ordinary log ranges retain decade and minor ticks", () => {
        expect(logScale(1, 1000)).toEqual({
            min: 1,
            max: 1000,
            ticks: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000],
        });
    });
});

describe("round 6 DST ticks", () => {
    test("spring transition skips nonexistent hours and half hours without duplicate or reversed ticks", () => {
        const start = Date.parse("2026-03-29T00:00:00Z");
        for (const width of [300, 600]) {
            const ticks = timeTicks({ range: [start, start + 3 * HOUR], width, timeZone: "Europe/Prague" });
            const expectedStep = width === 300 ? HOUR : 30 * MINUTE;
            expect(ticks.map((tick) => tick.t)).toEqual(
                Array.from({ length: (3 * HOUR) / expectedStep + 1 }, (_, index) => start + index * expectedStep)
            );
            expect(ticks.map((tick) => tick.label)).toEqual(
                width === 300
                    ? ["01:00", "03:00", "04:00", "05:00"]
                    : ["01:00", "01:30", "03:00", "03:30", "04:00", "04:30", "05:00"]
            );
        }
    });

    test("a nonexistent tick cannot stop scanning before a valid tick at the viewport end", () => {
        const start = Date.parse("2026-03-29T00:00:00Z");
        const ticks = timeTicks({
            range: [start, start + 70 * MINUTE],
            width: 300,
            timeZone: "Europe/Prague",
        });
        expect(ticks.map((tick) => tick.label)).toEqual(["01:00", "01:30", "03:00"]);
    });

    test("fall transition still resolves real wall-clock ticks after the offset changes", () => {
        const start = Date.parse("2026-10-25T00:00:00Z");
        const ticks = timeTicks({ range: [start, start + 3 * HOUR], width: 300, timeZone: "Europe/Prague" });
        expect(ticks.map((tick) => tick.label)).toEqual(["02:00", "03:00", "04:00"]);
        expect(ticks.map((tick) => tick.t)).toEqual([start, start + 2 * HOUR, start + 3 * HOUR]);
    });
});

describe("round 8 interval packing", () => {
    test("packing preserves first-free rows, ties, gaps and byte-identical lane layouts", () => {
        const items = Object.freeze(
            [
                { start: 11, end: 20 },
                { start: 1, end: 3 },
                { start: 0, end: 10 },
                { start: 2, end: 5 },
                { start: 11, end: 12 },
                { start: 12, end: 12 },
                { start: 12, end: 14 },
            ].map((item) => Object.freeze(item))
        );
        expect(packRows(items)).toEqual([1, 1, 0, 2, 0, 0, 0]);
        expect(packRows(items, 1)).toEqual([1, 1, 0, 2, 0, 2, 3]);
        expect(packRows(items, -1)).toEqual([0, 1, 0, 1, 0, 1, 1]);
        expect(packRows([])).toEqual([]);
        const spans = [
            ...items.map((item) => ({ ...item, lane: "work" })),
            { start: 0, end: 1, lane: "notes" },
            { start: 0, end: 1 },
        ];
        expect(SafeJSON.stringify(layoutLanes(spans))).toBe(
            SafeJSON.stringify([
                { name: "work", items: [0, 1, 2, 3, 4, 5, 6], itemRows: [1, 1, 0, 2, 0, 0, 0], rows: 3 },
                { name: "notes", items: [7], itemRows: [0], rows: 1 },
                { name: "Other", items: [8], itemRows: [0], rows: 1 },
            ])
        );
        expect(SafeJSON.stringify(layoutLanesIn(spans, [11, 12], ["work", "notes", "Other"]))).toBe(
            SafeJSON.stringify([
                { name: "work", items: [0, 4, 5, 6], itemRows: [1, 0, 0, 0], rows: 2 },
                { name: "notes", rows: 1, items: [], itemRows: [] },
                { name: "Other", rows: 1, items: [], itemRows: [] },
            ])
        );
    });

    test("dense overlaps stay within a logarithmic comparison-operand budget", () => {
        const count = 4096;
        let coordinateReads = 0;
        const items = Array.from({ length: count }, () => ({
            get start() {
                coordinateReads += 1;
                return 0;
            },
            get end() {
                coordinateReads += 1;
                return 1;
            },
        }));
        expect(packRows(items)).toEqual(Array.from({ length: count }, (_, index) => index));
        expect(coordinateReads).toBeLessThanOrEqual(8 * count * Math.ceil(Math.log2(count)));
    });
});

describe("round 11 auto-theme canvas colors", () => {
    test("canvas paints concrete auto-theme colors and resolves them again after a scheme flip", async () => {
        const dom = await mountDom(<p>canvas theme harness</p>);
        const css = await Bun.file(new URL("../templates/auto/theme.css", import.meta.url)).text();
        const tokens = Object.fromEntries(
            [...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()])
        );
        const paints: string[] = [];
        const probes: Element[] = [];
        const nativeComputed = dom.window.getComputedStyle.bind(dom.window);
        const computed: typeof dom.window.getComputedStyle = (element, pseudo) =>
            new Proxy(nativeComputed(element, pseudo), {
                get(target, key) {
                    if (key === "getPropertyValue") {
                        return (name: string) => tokens[name] ?? target.getPropertyValue(name);
                    }

                    if (
                        key === "color" &&
                        element instanceof dom.window.HTMLSpanElement &&
                        element.style.display === "none"
                    ) {
                        if (element.parentElement) {
                            probes.push(element.parentElement);
                        }

                        let raw = element.style.color;
                        const variable = /^var\((--[\w-]+)\)$/.exec(raw);
                        raw = variable ? (tokens[variable[1]] ?? raw) : raw;
                        const pair = /^light-dark\((rgb\([^)]+\)|#[\da-f]+),\s*(rgb\([^)]+\)|#[\da-f]+)\)$/.exec(raw);
                        if (pair) {
                            const sample = dom.window.document.createElement("span");
                            sample.style.color =
                                pair[dom.window.document.documentElement.getAttribute("data-theme") === "dark" ? 2 : 1];
                            return sample.style.color;
                        }
                    }

                    const value = Reflect.get(target, key, target);
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
        const context = new Proxy<Record<string, unknown>>(
            { measureText: () => ({ width: 30 }) },
            {
                get(target, key) {
                    return Reflect.has(target, key) ? Reflect.get(target, key) : () => undefined;
                },
                set(target, key, value) {
                    if ((key === "fillStyle" || key === "strokeStyle") && typeof value === "string") {
                        paints.push(value);
                    }

                    return Reflect.set(target, key, value);
                },
            }
        );
        Object.defineProperty(dom.window.HTMLCanvasElement.prototype, "getContext", {
            configurable: true,
            value: () => context,
        });
        Object.defineProperty(dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
        dom.window.getComputedStyle = computed;
        Object.assign(globalThis, { getComputedStyle: computed });
        try {
            await dom.render(
                <TimeSeries
                    series={[
                        {
                            id: "load",
                            label: "Load",
                            points: [
                                [T0, 1],
                                [T0 + HOUR, 2],
                            ],
                        },
                    ]}
                />
            );
            for (const color of [
                "rgb(246, 247, 249)",
                "rgb(255, 255, 255)",
                "rgb(219, 224, 232)",
                "rgb(29, 78, 216)",
            ]) {
                expect(paints).toContain(color);
            }
            expect(paints.some((color) => /light-dark\(|color-mix\(|var\(/.test(color))).toBe(false);
            expect(probes.length).toBeGreaterThan(0);
            expect(probes.every((element) => dom.container.contains(element))).toBe(true);
            paints.length = 0;
            await act(async () => {
                dom.window.document.documentElement.setAttribute("data-theme", "dark");
                await Promise.resolve();
            });
            for (const color of ["rgb(13, 15, 19)", "rgb(21, 25, 32)", "rgb(37, 43, 54)", "rgb(108, 182, 240)"]) {
                expect(paints).toContain(color);
            }
            expect(paints.some((color) => /light-dark\(|color-mix\(|var\(/.test(color))).toBe(false);
        } finally {
            await dom.unmount();
            dom.window.getComputedStyle = nativeComputed;
            Object.assign(globalThis, { getComputedStyle: nativeComputed });
        }
    });
});
