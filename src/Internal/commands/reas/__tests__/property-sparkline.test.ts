import { describe, expect, test } from "bun:test";
import type { PropertyAnalysisHistoryRow } from "@app/Internal/commands/reas/lib/store";
import { buildSparklinePoints } from "@app/Internal/commands/reas/ui/src/components/watchlist/property-sparkline";

function makeHistoryRow(overrides?: Partial<PropertyAnalysisHistoryRow>): PropertyAnalysisHistoryRow {
    return {
        id: 1,
        property_id: 1,
        analyzed_at: "2026-04-01T00:00:00.000Z",
        grade: "B",
        score: 64,
        net_yield: 3.6,
        gross_yield: 4.4,
        median_price_per_m2: 101000,
        comparable_count: 8,
        rental_median: 21000,
        full_result_json: "{}",
        ...overrides,
    };
}

describe("buildSparklinePoints", () => {
    test("returns normalized points ordered oldest to newest", () => {
        const points = buildSparklinePoints(
            [
                makeHistoryRow({ id: 3, analyzed_at: "2026-04-03T00:00:00.000Z", net_yield: 3.9 }),
                makeHistoryRow({ id: 1, analyzed_at: "2026-04-01T00:00:00.000Z", net_yield: 3.4 }),
                makeHistoryRow({ id: 2, analyzed_at: "2026-04-02T00:00:00.000Z", net_yield: 3.7 }),
            ],
            (row: PropertyAnalysisHistoryRow) => row.net_yield
        );

        expect(points).toHaveLength(3);
        expect(points[0]).toBe("0,24");
        expect(points[2]).toBe("100,0");
    });

    test("returns empty array when fewer than two finite values exist", () => {
        const points = buildSparklinePoints(
            [makeHistoryRow({ net_yield: null })],
            (row: PropertyAnalysisHistoryRow) => row.net_yield
        );
        expect(points).toEqual([]);
    });
});
