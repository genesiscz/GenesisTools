import { describe, expect, test } from "bun:test";
import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import type { ListingRow } from "@app/Internal/commands/reas/lib/store";
import {
    buildAnalysisCompareQuery,
    buildComparePeriodControlOptions,
    buildCompareSearchParams,
    buildListingCompareQuery,
    DEFAULT_COMPARE_DISTRICTS,
    getDefaultComparePeriods,
    parseCompareSearchParams,
} from "@app/Internal/commands/reas/ui/src/components/compare/compare-query";

describe("compare-query", () => {
    test("builds compact search params from compare state", () => {
        const params = buildCompareSearchParams({
            districts: ["Praha 2", "Praha 3", "Praha 2"],
            propertyType: "brick",
            disposition: "2+kk",
            periods: "2024,2025,2026",
            price: "5000000",
            area: "80",
        });

        expect(params.toString()).toBe(
            "districts=Praha+2%2CPraha+3&type=brick&disposition=2%2Bkk&periods=2024%2C2025%2C2026&price=5000000&area=80&resolution=monthly"
        );
    });

    test("parses compare state from a URL search string and clamps max districts", () => {
        const parsed = parseCompareSearchParams({
            search: "?districts=Praha%202,Praha%203,Praha%204,Praha%205,Praha%206&type=panel&disposition=3%2Bkk&periods=2024,2025&price=6100000&area=92",
            maxDistricts: 4,
        });

        expect(parsed).toEqual({
            districts: ["Praha 2", "Praha 3", "Praha 4", "Praha 5"],
            propertyType: "panel",
            disposition: "3+kk",
            periods: "2024,2025",
            price: "6100000",
            area: "92",
            snapshotResolution: "monthly",
        });
    });

    test("defaults compare periods to a meaningful sold horizon", () => {
        const parsed = parseCompareSearchParams({
            search: "?districts=Praha%202,Praha%203&type=brick&price=5000000&area=80",
            maxDistricts: 12,
        });

        expect(parsed.periods).toBe(getDefaultComparePeriods());
    });

    test("builds compare params from analysis results", () => {
        const params = buildAnalysisCompareQuery(makeExportData());

        expect(params.get("districts")).toBe("Praha 2");
        expect(params.get("type")).toBe("brick");
        expect(params.get("disposition")).toBe("2+kk");
        expect(params.get("periods")).toBe(getDefaultComparePeriods());
        expect(params.get("price")).toBe("5000000");
        expect(params.get("area")).toBe("80");
    });

    test("preserves explicit analysis periods in compare params when export metadata knows them", () => {
        const data = makeExportData();
        data.meta.filters.periods = [
            {
                label: "2023",
                from: new Date("2023-01-01T00:00:00.000Z"),
                to: new Date("2023-12-31T23:59:59.000Z"),
            },
            {
                label: "2024",
                from: new Date("2024-01-01T00:00:00.000Z"),
                to: new Date("2024-12-31T23:59:59.000Z"),
            },
        ];
        const params = buildAnalysisCompareQuery(data);

        expect(params.get("periods")).toBe("2023,2024");
    });

    test("builds compare params from listing detail rows", () => {
        const params = buildListingCompareQuery(
            makeListing({ district: "Praha 8", building_type: "panel", disposition: "1+kk" })
        );

        expect(params.get("districts")).toBe("Praha 8");
        expect(params.get("type")).toBe("panel");
        expect(params.get("disposition")).toBe("1+kk");
        expect(params.get("periods")).toBe(getDefaultComparePeriods());
        expect(params.get("price")).toBe("4200000");
        expect(params.get("area")).toBe("42");
    });

    test("falls back to the default district basket when search has no districts", () => {
        const parsed = parseCompareSearchParams({
            search: "?type=brick&price=5000000&area=80",
            maxDistricts: 12,
        });

        expect(parsed.districts).toEqual([...DEFAULT_COMPARE_DISTRICTS]);
    });

    test("preserves an explicitly cleared district basket in the URL", () => {
        const params = buildCompareSearchParams({
            districts: [],
            propertyType: "brick",
            disposition: "all",
            price: "5000000",
            area: "80",
        });
        const parsed = parseCompareSearchParams({
            search: `?${params.toString()}`,
            maxDistricts: 12,
        });

        expect(params.toString()).toBe(
            "districts=&type=brick&periods=2024%2C2025%2C2026&price=5000000&area=80&resolution=monthly"
        );
        expect(parsed.districts).toEqual([]);
    });

    test("adds a custom visible control option when preserved periods do not match presets", () => {
        expect(buildComparePeriodControlOptions("2023,2024")).toContainEqual({
            value: "2023,2024",
            label: "Custom · 2023,2024",
        });
    });
});

function makeExportData(): DashboardExport {
    return {
        meta: {
            generatedAt: "2026-04-03T00:00:00.000Z",
            version: "1.0",
            filters: {
                estateType: "flat",
                constructionType: "brick",
                periods: [],
                district: {
                    name: "Praha 2",
                    reasId: 10,
                    srealityId: 20,
                    srealityLocality: "district",
                },
                providers: ["reas"],
            },
            target: {
                price: 5000000,
                area: 80,
                disposition: "2+kk",
                constructionType: "brick",
                monthlyRent: 22000,
                monthlyCosts: 4000,
                district: "Praha 2",
                districtId: 10,
                srealityDistrictId: 20,
            },
            providers: ["reas"],
        },
        listings: {
            sold: [],
            activeSales: [],
            rentals: [],
        },
        analysis: {
            comparables: {
                median: 120000,
                mean: 121000,
                p25: 115000,
                p75: 126000,
                count: 24,
                targetPercentile: 52,
            },
            trends: [],
            yield: {
                grossYield: 4.5,
                netYield: 3.8,
                paybackYears: 22,
                atMarketPrice: {
                    price: 5000000,
                    grossYield: 4.2,
                    netYield: 3.5,
                    paybackYears: 24,
                },
            },
            timeOnMarket: {
                median: 30,
                mean: 32,
                min: 12,
                max: 70,
            },
            discount: {
                avgDiscount: 1.2,
                medianDiscount: 1.0,
                maxDiscount: 3.4,
            },
            priceHistogram: [],
            domDistribution: [],
            scatter: [],
        },
        benchmarks: {
            mf: [],
            investmentBenchmarks: [],
        },
    };
}

function makeListing(overrides?: Partial<ListingRow>): ListingRow {
    return {
        id: 1,
        source: "sreality",
        source_contract: "rentals/v1",
        type: "sale",
        status: "active",
        district: "Praha 2",
        disposition: "2+kk",
        area: 42,
        price: 4200000,
        price_per_m2: 100000,
        address: "Test address",
        link: "https://example.com/listing",
        source_id: "abc",
        fetched_at: "2026-04-03T00:00:00.000Z",
        sold_at: null,
        days_on_market: null,
        discount: null,
        coordinates_lat: null,
        coordinates_lng: null,
        building_type: "brick",
        description: null,
        raw_json: "{}",
        previous_price: null,
        price_changed_at: null,
        created_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-03T00:00:00.000Z",
        ...overrides,
    };
}
