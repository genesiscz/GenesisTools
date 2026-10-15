import { describe, expect, test } from "bun:test";
import { tabHash, tabIdFromHash } from "./data";
import { composeHash, isChartSegment, plainSegment, withPlainSegment } from "./hash";
import { mountDom } from "./test-dom";
import { TimeSeries } from "./timeseries";
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
    MINUTE,
    nearestIndex,
    niceScale,
    orderPanels,
    packRows,
    plainText,
    readHashState,
    stackPoints,
    stripTags,
    type TsPoint,
    timeTicks,
    toCsv,
    tzOffset,
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
            [5, 11],
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
