import { describe, expect, test } from "bun:test";
import { type ChartSeries, chartRows, chartStackMax, logTicksFor, seriesKey } from "./charts";

const labels = ["mon", "tue", "wed"];

describe("chartRows", () => {
    test("keys rows by series INDEX, so two series may share a label", () => {
        const series: ChartSeries[] = [
            { label: "errors", values: [1, 2, 3] },
            { label: "errors", values: [10, 20, 30] },
        ];
        const rows = chartRows(labels, series, false);

        expect(rows[0]).toEqual({ x: "mon", [seriesKey(0)]: 1, [seriesKey(1)]: 10 });
        expect(rows[2]).toEqual({ x: "wed", [seriesKey(0)]: 3, [seriesKey(1)]: 30 });
    });

    test("drops zero and negative points on a log scale, keeps them otherwise", () => {
        const series: ChartSeries[] = [{ label: "a", values: [0, -5, 7] }];

        expect(chartRows(labels, series, true).map((r) => r[seriesKey(0)])).toEqual([null, null, 7]);
        expect(chartRows(labels, series, false).map((r) => r[seriesKey(0)])).toEqual([0, -5, 7]);
    });

    test("non-finite points become null instead of poisoning the row", () => {
        const series: ChartSeries[] = [{ label: "a", values: [Number.POSITIVE_INFINITY, Number.NaN, 4] }];

        expect(chartRows(labels, series, false).map((r) => r[seriesKey(0)])).toEqual([null, null, 4]);
    });
});

describe("chartStackMax", () => {
    test("totals each NAMED stack on its own instead of summing all stacked bars", () => {
        const series: ChartSeries[] = [
            { label: "a1", values: [60, 0, 0], stack: "left" },
            { label: "a2", values: [40, 0, 0], stack: "left" },
            { label: "b1", values: [70, 0, 0], stack: "right" },
            { label: "b2", values: [30, 0, 0], stack: "right" },
        ];

        // Two independent stacks of 100 each: the axis must top out at 100, not 200.
        expect(chartStackMax(labels, series)).toBe(100);
    });

    test("the default shared stack still sums together", () => {
        const series: ChartSeries[] = [
            { label: "a", values: [60, 0, 0], stack: true },
            { label: "b", values: [40, 0, 0], stack: true },
        ];

        expect(chartStackMax(labels, series)).toBe(100);
    });

    test("lines and unstacked bars use their own tallest point", () => {
        const series: ChartSeries[] = [
            { label: "line", values: [5, 250, 9], kind: "line" },
            { label: "bar", values: [10, 20, 30] },
        ];

        expect(chartStackMax(labels, series)).toBe(250);
    });

    test("ignores non-finite values and never drops below 1", () => {
        expect(chartStackMax(labels, [{ label: "a", values: [Number.POSITIVE_INFINITY, Number.NaN, null] }])).toBe(1);
        expect(chartStackMax(labels, [])).toBe(1);
    });
});

describe("logTicksFor", () => {
    test("the last tick always covers the max, so allowDataOverflow cannot clip", () => {
        for (const max of [1, 2, 3, 3.1, 9, 10, 11, 99, 100, 301, 1234]) {
            const ticks = logTicksFor(max);
            expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
        }
    });

    test("emits the 1-3-10 decade sequence without a redundant top tick", () => {
        expect(logTicksFor(3.1)).toEqual([1, 3, 10]);
        expect(logTicksFor(100)).toEqual([1, 3, 10, 30, 100]);
        expect(logTicksFor(1)).toEqual([1, 3]);
    });

    test("terminates on a non-finite max instead of looping forever", () => {
        // A single Infinity in the data used to make `t *= 10` stay Infinity and
        // spin the tick loop forever, locking up the browser. chartStackMax now
        // filters those out, so the tick loop only ever sees a finite max.
        const series: ChartSeries[] = [{ label: "a", values: [Number.POSITIVE_INFINITY, 4, 4] }];
        const ticks = logTicksFor(chartStackMax(labels, series));

        expect(ticks.every((t) => Number.isFinite(t))).toBe(true);
        expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(4);
    });
});
