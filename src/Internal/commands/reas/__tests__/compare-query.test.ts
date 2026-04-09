import { describe, expect, test } from "bun:test";
import type { SavedPropertyRow } from "@app/Internal/commands/reas/lib/store";
import {
    buildCompareSearchParams,
    getDefaultComparePeriods,
    parseCompareSearchParams,
} from "@app/Internal/commands/reas/ui/src/components/compare/compare-query";
import { buildWatchlistCompareQuery } from "@app/Internal/commands/reas/ui/src/components/watchlist/compare-query";

function makeProperty(overrides?: Partial<SavedPropertyRow>): SavedPropertyRow {
    return {
        id: 1,
        name: "Property",
        district: "Praha 2",
        construction_type: "brick",
        disposition: "2+kk",
        target_price: 6000000,
        target_area: 60,
        monthly_rent: 22000,
        monthly_costs: 4000,
        periods: null,
        providers: null,
        listing_url: null,
        last_score: null,
        last_grade: null,
        last_net_yield: null,
        last_gross_yield: null,
        last_median_price_per_m2: null,
        score: null,
        gross_yield: null,
        payback_years: null,
        percentile: null,
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
        last_analyzed_at: null,
        notes: null,
        created_at: "2026-04-02 00:00:00",
        updated_at: "2026-04-02 00:00:00",
        ...overrides,
    };
}

describe("buildWatchlistCompareQuery", () => {
    test("builds compare defaults from selected properties", () => {
        const params = buildWatchlistCompareQuery([
            makeProperty(),
            makeProperty({ id: 2, district: "Hradec Králové", target_price: 4000000, target_area: 80 }),
        ]);

        expect(params.get("districts")).toBe("Praha 2,Hradec Králové");
        expect(params.get("type")).toBe("brick");
        expect(params.get("disposition")).toBe("2+kk");
        expect(params.get("periods")).toBe(getDefaultComparePeriods());
        expect(params.get("price")).toBe("5000000");
        expect(params.get("area")).toBe("70");
    });

    test("deduplicates districts and omits zero averages", () => {
        const params = buildWatchlistCompareQuery([
            makeProperty({ target_price: 0, target_area: 0 }),
            makeProperty({ id: 2, district: "Praha 2", target_price: 0, target_area: 0 }),
        ]);

        expect(params.get("districts")).toBe("Praha 2");
        expect(params.get("periods")).toBe(getDefaultComparePeriods());
        expect(params.get("price")).toBeNull();
        expect(params.get("area")).toBeNull();
    });

    test("preserves shared watchlist periods when all selected properties use the same horizon", () => {
        const params = buildWatchlistCompareQuery([
            makeProperty({ periods: "2022,2023" }),
            makeProperty({ id: 2, district: "Praha 3", periods: "2022,2023" }),
        ]);

        expect(params.get("periods")).toBe("2022,2023");
    });
});

describe("compare search params", () => {
    test("persists snapshot resolution in the compare URL state", () => {
        const params = buildCompareSearchParams({
            districts: ["Praha 2", "Praha 3"],
            snapshotResolution: "daily",
        });

        expect(params.get("resolution")).toBe("daily");
    });

    test("defaults snapshot resolution to monthly when the URL does not specify one", () => {
        const parsed = parseCompareSearchParams({
            search: "?districts=Praha%202,Praha%203&type=brick",
            maxDistricts: 12,
        });

        expect(parsed.snapshotResolution).toBe("monthly");
    });
});
