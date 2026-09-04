import { describe, expect, test } from "bun:test";
import type { SpendSeriesPoint } from "@app/dev-dashboard/contract/ai-accounts";
import { buildSpendChartData, formatUsd, parseBucketTime, sumVisible } from "./spend-chart-data";

const POINTS: SpendSeriesPoint[] = [
    {
        t: "2026-09-03T00:00:00.000Z",
        costUsd: 3,
        tokens: 300,
        byAccount: {
            acc_work: { costUsd: 1, tokens: 100 },
            acc_shop: { costUsd: 2, tokens: 200 },
        },
        byModel: { "gpt-5.6": { costUsd: 3, tokens: 300 } },
    },
    {
        t: "2026-09-04T00:00:00.000Z",
        costUsd: 5,
        tokens: 500,
        byAccount: {
            acc_work: { costUsd: 5, tokens: 500 },
        },
        byModel: { "claude-opus-5": { costUsd: 5, tokens: 500 } },
    },
];

describe("buildSpendChartData", () => {
    test("stacked mode has one key per visible account on every row", () => {
        const { rows, keys } = buildSpendChartData(POINTS, { mode: "stacked", hiddenAccountIds: new Set() });

        expect(keys.sort()).toEqual(["acc_shop", "acc_work"]);
        expect(rows).toHaveLength(2);
        expect(rows[1].acc_shop).toBe(0);
        expect(rows[1].acc_work).toBe(5);
    });

    test("hidden accounts are dropped and total reflects the toggles", () => {
        const hidden = new Set(["acc_shop"]);
        const stacked = buildSpendChartData(POINTS, { mode: "stacked", hiddenAccountIds: hidden });
        const total = buildSpendChartData(POINTS, { mode: "total", hiddenAccountIds: hidden });

        expect(stacked.keys).toEqual(["acc_work"]);
        expect(total.rows[0].total).toBe(1);
        expect(total.rows[1].total).toBe(5);
    });

    test("byModel mode keys by model and fills missing models with zero", () => {
        const { rows, keys } = buildSpendChartData(POINTS, { mode: "byModel", hiddenAccountIds: new Set() });

        expect(keys.sort()).toEqual(["claude-opus-5", "gpt-5.6"]);
        expect(rows[0]["claude-opus-5"]).toBe(0);
        expect(rows[1]["gpt-5.6"]).toBe(0);
    });

    test("rows are sorted by time and junk timestamps are skipped", () => {
        const reversed = [...POINTS].reverse();
        const withJunk = [...reversed, { ...POINTS[0], t: "nope" }];
        const { rows } = buildSpendChartData(withJunk, { mode: "lines", hiddenAccountIds: new Set() });

        expect(rows.map((r) => r.t)).toEqual([...rows.map((r) => r.t)].sort((a, b) => a - b));
        expect(rows).toHaveLength(2);
    });
});

describe("parseBucketTime", () => {
    test("an hour bucket key is local wall-clock, not Invalid Date", () => {
        const parsed = parseBucketTime("2026-09-04T20");

        expect(Number.isNaN(parsed)).toBe(false);
        expect(new Date(parsed).getHours()).toBe(20);
        expect(new Date(parsed).getDate()).toBe(4);
    });

    test("a day bucket key is local midnight, so it does not shift across the zone", () => {
        const parsed = parseBucketTime("2026-09-04");

        expect(new Date(parsed).getHours()).toBe(0);
        expect(new Date(parsed).getDate()).toBe(4);
    });

    test("a minute bucket key keeps its minute", () => {
        expect(new Date(parseBucketTime("2026-09-04T20:37")).getMinutes()).toBe(37);
    });

    test("a full ISO instant still parses as an instant", () => {
        expect(parseBucketTime("2026-09-04T20:00:00.000Z")).toBe(Date.parse("2026-09-04T20:00:00.000Z"));
    });

    test("junk stays NaN so the chart drops it", () => {
        expect(Number.isNaN(parseBucketTime("nope"))).toBe(true);
    });
});

describe("buildSpendChartData with hour buckets", () => {
    test("hour-grain points are plotted rather than discarded", () => {
        const hourly: SpendSeriesPoint[] = [
            { t: "2026-09-04T19", costUsd: 1, tokens: 10, byAccount: { acc_work: { costUsd: 1, tokens: 10 } } },
            { t: "2026-09-04T20", costUsd: 2, tokens: 20, byAccount: { acc_work: { costUsd: 2, tokens: 20 } } },
        ];
        const { rows, keys } = buildSpendChartData(hourly, { mode: "stacked", hiddenAccountIds: new Set() });

        expect(keys).toEqual(["acc_work"]);
        expect(rows).toHaveLength(2);
        expect(rows[1].t - rows[0].t).toBe(3_600_000);
    });
});

describe("sumVisible", () => {
    test("sums only visible accounts", () => {
        expect(sumVisible(POINTS, new Set())).toEqual({ costUsd: 8, tokens: 800 });
        expect(sumVisible(POINTS, new Set(["acc_work"]))).toEqual({ costUsd: 2, tokens: 200 });
    });
});

describe("formatUsd", () => {
    test("scales the precision with the amount", () => {
        expect(formatUsd(0)).toBe("$0");
        expect(formatUsd(0.0042)).toBe("$0.0042");
        expect(formatUsd(4.5678)).toBe("$4.57");
        expect(formatUsd(1234.5)).toBe("$1,235");
    });
});
