import type { MultiBucketHistoryResult } from "@dd/contract";
import { describe, expect, it } from "bun:test";
import { bucketLabel, DASH, historyToBucketSeries, utilizationPct } from "@/features/claude-usage/units";

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
                        { id: 1, timestamp: "2026-05-29T00:00:00Z", accountName: "main", bucket: "five_hour", utilization: 0.4, resetsAt: null },
                        { id: 2, timestamp: "2026-05-29T01:00:00Z", accountName: "main", bucket: "five_hour", utilization: 0.55, resetsAt: null },
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
                    snapshots: [{ id: 1, timestamp: "not-a-date", accountName: "main", bucket: "five_hour", utilization: 0.1, resetsAt: null }],
                },
            ],
        };

        expect(historyToBucketSeries(history)[0].points).toHaveLength(0);
    });
});
