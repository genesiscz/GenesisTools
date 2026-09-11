import type { MultiBucketHistoryResult } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import {
    accountLabel,
    appsSummary,
    bucketLabel,
    DASH,
    formatCount,
    formatTokens,
    formatUsd,
    historyToBucketSeries,
    unpricedHint,
    utilizationPct,
} from "@/features/claude-usage/units";

describe("claude-usage units — formatters", () => {
    it("utilizationPct rounds 0-1 to an integer percent, em-dash on missing", () => {
        expect(utilizationPct({ utilization: 0.4, resets_at: null })).toBe("40%");
        expect(utilizationPct({ utilization: 0.555, resets_at: null })).toBe("56%");
        expect(utilizationPct(null)).toBe(DASH);
        expect(utilizationPct(undefined)).toBe(DASH);
    });

    it("bucketLabel maps known buckets, falls back to the raw key", () => {
        expect(bucketLabel("five_hour")).toBe("5h");
        expect(bucketLabel("seven_day")).toBe("7d");
        expect(bucketLabel("mystery_bucket")).toBe("mystery_bucket");
    });
});

describe("claude-usage units — historyToBucketSeries", () => {
    // Hand-built fixtures (NOT the mock — the mock returns the wrong shape for /history; see notes).
    it("maps each bucket to a series with utilization as percent (0-100) and epoch-ms x", () => {
        const history: MultiBucketHistoryResult = {
            series: [
                {
                    bucket: "five_hour",
                    snapshots: [
                        { id: 1, timestamp: "2026-05-29T00:00:00Z", accountName: "main", bucket: "five_hour", utilization: 0.4, resetsAt: null, severity: null, scopeModel: null },
                        { id: 2, timestamp: "2026-05-29T01:00:00Z", accountName: "main", bucket: "five_hour", utilization: 0.55, resetsAt: null, severity: null, scopeModel: null },
                    ],
                },
                { bucket: "seven_day", snapshots: [] },
            ],
        };

        const result = historyToBucketSeries(history);
        expect(result).toHaveLength(2);
        expect(result[0].key).toBe("five_hour");
        expect(result[0].label).toBe("5h");
        expect(result[0].points).toHaveLength(2);
        expect(result[0].points[0].value).toBeCloseTo(40);
        expect(result[0].points[1].value).toBeCloseTo(55);
        expect(result[0].points[0].ts).toBe(Date.parse("2026-05-29T00:00:00Z"));
        expect(result[1].points).toHaveLength(0);
    });

    it("drops snapshots with an unparseable timestamp", () => {
        const history: MultiBucketHistoryResult = {
            series: [
                {
                    bucket: "five_hour",
                    snapshots: [{ id: 1, timestamp: "not-a-date", accountName: "main", bucket: "five_hour", utilization: 0.1, resetsAt: null, severity: null, scopeModel: null }],
                },
            ],
        };

        expect(historyToBucketSeries(history)[0].points).toHaveLength(0);
    });
});

describe("claude-usage units — recorded spend", () => {
    it("formatUsd keeps four decimals below a cent so small spend does not read as free", () => {
        expect(formatUsd(0)).toBe("$0");
        expect(formatUsd(0.0004)).toBe("$0.0004");
        expect(formatUsd(0.009_9)).toBe("$0.0099");
        expect(formatUsd(0.01)).toBe("$0.01");
        expect(formatUsd(12.472)).toBe("$12.47");
    });

    it("formatTokens compacts to K/M and drops a trailing .0", () => {
        expect(formatTokens(0)).toBe("0");
        expect(formatTokens(999)).toBe("999");
        expect(formatTokens(12_000)).toBe("12K");
        expect(formatTokens(1_250)).toBe("1.3K");
        expect(formatTokens(8_420_000)).toBe("8.4M");
        expect(formatTokens(2_000_000)).toBe("2M");
    });

    it("formatCount groups thousands without a locale", () => {
        expect(formatCount(0)).toBe("0");
        expect(formatCount(999)).toBe("999");
        expect(formatCount(1_284)).toBe("1,284");
        expect(formatCount(1_234_567)).toBe("1,234,567");
    });

    it("unpricedHint is undefined at zero and singular at one", () => {
        expect(unpricedHint(0)).toBeUndefined();
        expect(unpricedHint(1)).toBe("1 call with no known rate");
        expect(unpricedHint(1_284)).toBe("1,284 calls with no known rate");
    });

    it("appsSummary orders by event count, busiest first", () => {
        expect(
            appsSummary({
                codex: { events: 182 },
                claude: { events: 1_102 },
            }),
        ).toBe("claude 1,102 · codex 182");
        expect(appsSummary({})).toBe("");
    });

    it("accountLabel appends the label only when there is one", () => {
        expect(accountLabel({ name: "work", label: "max" })).toBe("work (max)");
        expect(accountLabel({ name: "personal" })).toBe("personal");
    });
});
