import { describe, expect, test } from "bun:test";
import type { SpendSeriesPoint } from "@app/dev-dashboard/contract/ai-accounts";
import { bucketLabel, buildSpendChartData, formatUsd, parseBucketTime, sumVisible } from "./spend-chart-data";

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

/**
 * `spendBucketKey` emits four shapes, all LOCAL wall-clock by design: a day and
 * a week as `YYYY-MM-DD` (the week being its Monday), an hour as
 * `YYYY-MM-DDTHH`, a minute as `YYYY-MM-DDTHH:mm`. One test per shape, each
 * asserting the local fields rather than an epoch number, so the suite passes in
 * any zone and still fails if a shape goes back through `new Date(string)`.
 */
describe("parseBucketTime", () => {
    test("minute: `2026-09-04T20:37` keeps its local hour and minute", () => {
        const at = new Date(parseBucketTime("2026-09-04T20:37"));

        expect(at.getFullYear()).toBe(2026);
        expect(at.getMonth()).toBe(8);
        expect(at.getDate()).toBe(4);
        expect(at.getHours()).toBe(20);
        expect(at.getMinutes()).toBe(37);
    });

    test("hour: `2026-09-04T20` is 8pm local, where `new Date` gives Invalid Date", () => {
        const at = new Date(parseBucketTime("2026-09-04T20"));

        expect(Number.isNaN(at.getTime())).toBe(false);
        expect(Number.isNaN(new Date("2026-09-04T20").getTime())).toBe(true);
        expect(at.getDate()).toBe(4);
        expect(at.getHours()).toBe(20);
        expect(at.getMinutes()).toBe(0);
    });

    test("day: `2026-09-04` is local midnight, not UTC midnight", () => {
        const at = new Date(parseBucketTime("2026-09-04"));

        expect(at.getDate()).toBe(4);
        expect(at.getHours()).toBe(0);
        expect(at.getMinutes()).toBe(0);
    });

    test("week: the Monday shares the day shape and lands on that local Monday", () => {
        const at = new Date(parseBucketTime("2026-08-31"));

        expect(at.getDay()).toBe(1);
        expect(at.getDate()).toBe(31);
        expect(at.getHours()).toBe(0);
    });

    test("a day key differs from the naive parse by exactly the zone offset", () => {
        const ours = new Date(parseBucketTime("2026-09-04"));
        const naive = new Date("2026-09-04");

        expect(ours.getHours()).toBe(0);
        expect(ours.getTime() - ours.getTimezoneOffset() * 60_000).toBe(naive.getTime());
    });

    test("a full ISO instant still parses as an instant", () => {
        expect(parseBucketTime("2026-09-04T20:00:00.000Z")).toBe(Date.parse("2026-09-04T20:00:00.000Z"));
    });

    test("junk stays NaN so the chart drops it", () => {
        expect(Number.isNaN(parseBucketTime("nope"))).toBe(true);
    });
});

describe("bucketLabel", () => {
    test("an hour bucket is labelled with the local hour it names", () => {
        const label = bucketLabel("hour", 360)(parseBucketTime("2026-09-04T20"));

        expect(label).toContain("20:00");
    });

    test("a minute bucket is labelled with the local minute it names", () => {
        expect(bucketLabel("minute", 60)(parseBucketTime("2026-09-04T20:37"))).toContain("20:37");
    });

    test("a day bucket prints a date, never a midnight time", () => {
        const label = bucketLabel("day", 10080)(parseBucketTime("2026-09-04"));

        expect(label).not.toContain("00:00");
        expect(label).toContain("4");
    });

    test("a week bucket prints a date too", () => {
        expect(bucketLabel("week", 200000)(parseBucketTime("2026-08-31"))).not.toContain("00:00");
    });

    test("a long window keeps the date beside the time for hour buckets", () => {
        expect(bucketLabel("hour", 4320)(parseBucketTime("2026-09-04T20"))).toContain("9/4");
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
