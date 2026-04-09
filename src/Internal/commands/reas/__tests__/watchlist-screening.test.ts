import { describe, expect, test } from "bun:test";
import type { SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import { screenWatchlistProperties } from "@app/Internal/commands/reas/ui/src/components/watchlist/watchlist-screening";

function makeProperty(overrides?: Partial<SavedPropertyRow>): SavedPropertyRow {
    return {
        id: 1,
        name: "Alpha",
        district: "Praha 2",
        construction_type: "brick",
        disposition: "2+kk",
        target_price: 5000000,
        target_area: 60,
        monthly_rent: 20000,
        monthly_costs: 4000,
        periods: null,
        providers: null,
        listing_url: null,
        last_score: 75,
        last_grade: "B",
        last_net_yield: 4.5,
        last_gross_yield: null,
        last_median_price_per_m2: null,
        score: null,
        gross_yield: null,
        payback_years: null,
        percentile: 60,
        comparable_count: null,
        rental_count: null,
        time_on_market: null,
        discount_vs_market: null,
        momentum: null,
        last_analysis_json: null,
        mortgage_rate: null,
        mortgage_term: null,
        down_payment: null,
        loan_amount: null,
        alert_yield_floor: null,
        alert_grade_change: null,
        last_analyzed_at: new Date().toISOString(),
        notes: null,
        created_at: "2026-04-02 00:00:00",
        updated_at: "2026-04-02 00:00:00",
        ...overrides,
    };
}

describe("screenWatchlistProperties", () => {
    test("filters by grade band and yield range", () => {
        const properties = [
            makeProperty({ id: 1, last_grade: "A", last_net_yield: 5.1 }),
            makeProperty({ id: 2, name: "Beta", last_grade: "C", last_net_yield: 3.2 }),
            makeProperty({ id: 3, name: "Gamma", last_grade: "D", last_net_yield: 2.1 }),
        ];

        const result = screenWatchlistProperties(properties, {
            search: "",
            districtFilter: "all",
            gradeFilter: "A-C",
            analysisFilter: "all",
            yieldMin: "3.5",
            yieldMax: "6",
            sortKey: "yield",
            sortDirection: "desc",
        });

        expect(result.map((property) => property.id)).toEqual([1]);
    });

    test("sorts by name and percentile", () => {
        const properties = [
            makeProperty({ id: 1, name: "Gamma", percentile: 20 }),
            makeProperty({ id: 2, name: "Alpha", percentile: 80 }),
            makeProperty({ id: 3, name: "Beta", percentile: 50 }),
        ];

        const byName = screenWatchlistProperties(properties, {
            search: "",
            districtFilter: "all",
            gradeFilter: "all",
            analysisFilter: "all",
            yieldMin: "",
            yieldMax: "",
            sortKey: "name",
            sortDirection: "asc",
        });

        const byPercentile = screenWatchlistProperties(properties, {
            search: "",
            districtFilter: "all",
            gradeFilter: "all",
            analysisFilter: "all",
            yieldMin: "",
            yieldMax: "",
            sortKey: "percentile",
            sortDirection: "desc",
        });

        expect(byName.map((property) => property.name)).toEqual(["Alpha", "Beta", "Gamma"]);
        expect(byPercentile.map((property) => property.id)).toEqual([2, 3, 1]);
    });
});
