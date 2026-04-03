import { describe, expect, test } from "bun:test";
import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import {
    buildDistrictTrendModel,
    DISTRICT_TREND_TIMEFRAMES,
} from "@app/Internal/commands/reas/ui/src/components/compare/district-trend-model";
import type { DistrictComparison } from "@app/Internal/commands/reas/ui/src/components/compare/types";

function makeExportData(district: string): DashboardExport {
    return {
        meta: {
            generatedAt: "2026-04-03T00:00:00.000Z",
            version: "1.0",
            filters: {
                estateType: "flat",
                constructionType: "brick",
                periods: [],
                district: {
                    name: district,
                    reasId: 10,
                    srealityId: 20,
                    srealityLocality: "district",
                },
                providers: ["reas"],
            },
            target: {
                price: 6000000,
                area: 60,
                disposition: "2+kk",
                constructionType: "brick",
                monthlyRent: 22000,
                monthlyCosts: 4000,
                district,
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
                p25: 110000,
                p75: 130000,
                count: 20,
                targetPercentile: 50,
            },
            trends: [],
            yield: {
                grossYield: 4.5,
                netYield: 3.9,
                paybackYears: 22.2,
                atMarketPrice: {
                    price: 6000000,
                    grossYield: 4.2,
                    netYield: 3.6,
                    paybackYears: 23.8,
                },
            },
            timeOnMarket: {
                median: 30,
                mean: 32,
                min: 10,
                max: 80,
            },
            discount: {
                avgDiscount: 1.5,
                medianDiscount: 1.1,
                maxDiscount: 4.5,
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

function makeComparison(overrides?: Partial<DistrictComparison>): DistrictComparison {
    return {
        district: "Praha 2",
        exportData: makeExportData("Praha 2"),
        snapshots: [
            {
                district: "Praha 2",
                constructionType: "brick",
                disposition: null,
                medianPricePerM2: 110000,
                comparablesCount: 10,
                trendDirection: "up",
                yoyChange: 4.2,
                marketGrossYield: 4.2,
                marketNetYield: 3.5,
                snapshotDate: "2025-01-01",
            },
            {
                district: "Praha 2",
                constructionType: "brick",
                disposition: null,
                medianPricePerM2: 118000,
                comparablesCount: 12,
                trendDirection: "up",
                yoyChange: 5.1,
                marketGrossYield: 4.4,
                marketNetYield: 3.7,
                snapshotDate: "2025-10-01",
            },
            {
                district: "Praha 2",
                constructionType: "brick",
                disposition: null,
                medianPricePerM2: 121000,
                comparablesCount: 13,
                trendDirection: "up",
                yoyChange: 5.4,
                marketGrossYield: 4.5,
                marketNetYield: 3.9,
                snapshotDate: "2026-03-01",
            },
        ],
        summary: {
            medianPricePerM2: 121000,
            grossYield: 4.5,
            netYield: 3.9,
            daysOnMarket: 30,
            targetPercentile: 50,
            salesCount: 20,
            rentalCount: 14,
        },
        ...overrides,
    };
}

describe("buildDistrictTrendModel", () => {
    test("filters snapshots to the selected timeframe using the latest snapshot as anchor", () => {
        const model = buildDistrictTrendModel({
            comparisons: [
                makeComparison(),
                makeComparison({
                    district: "Praha 3",
                    snapshots: [
                        {
                            district: "Praha 3",
                            constructionType: "brick",
                            disposition: null,
                            medianPricePerM2: 100000,
                            comparablesCount: 9,
                            trendDirection: "up",
                            yoyChange: 1.2,
                            marketGrossYield: 3.8,
                            marketNetYield: 3.1,
                            snapshotDate: "2025-04-01",
                        },
                        {
                            district: "Praha 3",
                            constructionType: "brick",
                            disposition: null,
                            medianPricePerM2: 103000,
                            comparablesCount: 11,
                            trendDirection: "up",
                            yoyChange: 2.3,
                            marketGrossYield: 4,
                            marketNetYield: 3.3,
                            snapshotDate: "2025-12-01",
                        },
                        {
                            district: "Praha 3",
                            constructionType: "brick",
                            disposition: null,
                            medianPricePerM2: 104500,
                            comparablesCount: 12,
                            trendDirection: "flat",
                            yoyChange: 2.1,
                            marketGrossYield: 4.1,
                            marketNetYield: 3.4,
                            snapshotDate: "2026-03-01",
                        },
                    ],
                }),
            ],
            timeframeDays: DISTRICT_TREND_TIMEFRAMES[1].days,
            visibleDistricts: ["Praha 2", "Praha 3"],
        });

        expect(model.rows.map((row: { date: string }) => row.date)).toEqual(["2025-10-01", "2025-12-01", "2026-03-01"]);
        expect(model.rows[1]).toMatchObject({
            date: "2025-12-01",
            "Praha 3": 103000,
        });
        expect(model.rows[2]).toMatchObject({
            date: "2026-03-01",
            "Praha 2": 121000,
            "Praha 3": 104500,
        });
    });

    test("returns series metadata only for visible districts with the latest snapshot summary", () => {
        const model = buildDistrictTrendModel({
            comparisons: [
                makeComparison(),
                makeComparison({
                    district: "Praha 3",
                    summary: {
                        medianPricePerM2: 104500,
                        grossYield: 4.1,
                        netYield: 3.5,
                        daysOnMarket: 36,
                        targetPercentile: 42,
                        salesCount: 12,
                        rentalCount: 10,
                    },
                    snapshots: [
                        {
                            district: "Praha 3",
                            constructionType: "brick",
                            disposition: null,
                            medianPricePerM2: 104500,
                            comparablesCount: 12,
                            trendDirection: "flat",
                            yoyChange: 2.1,
                            marketGrossYield: 4.1,
                            marketNetYield: 3.4,
                            snapshotDate: "2026-03-01",
                        },
                    ],
                }),
            ],
            timeframeDays: DISTRICT_TREND_TIMEFRAMES[2].days,
            visibleDistricts: ["Praha 3"],
        });

        expect(model.series).toEqual([
            {
                district: "Praha 3",
                color: expect.any(String),
                latestValue: 104500,
                latestDate: "2026-03-01",
                yoyChange: 2.1,
            },
        ]);
    });
});
