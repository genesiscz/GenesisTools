import { describe, expect, test } from "bun:test";
import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import {
    buildDistrictContextItems,
    buildDistrictPriceBarModel,
    buildDistrictRadarModel,
    buildDistrictYieldBarModel,
} from "@app/Internal/commands/reas/ui/src/components/compare/district-comparison-model";
import type { DistrictComparison } from "@app/Internal/commands/reas/ui/src/components/compare/types";

function makeComparison(overrides?: Partial<DistrictComparison>): DistrictComparison {
    const district = overrides?.district ?? "Praha 2";

    return {
        district,
        exportData: makeExportData(district),
        snapshots: [
            {
                district,
                constructionType: "brick",
                disposition: "2+kk",
                medianPricePerM2: overrides?.summary?.medianPricePerM2 ?? 120000,
                comparablesCount: overrides?.summary?.salesCount ?? 20,
                trendDirection: "up",
                yoyChange: 4.2,
                marketGrossYield: 4.2,
                marketNetYield: 3.5,
                snapshotDate: "2026-03-01",
            },
        ],
        summary: {
            medianPricePerM2: 120000,
            grossYield: 4.5,
            netYield: 3.8,
            daysOnMarket: 30,
            targetPercentile: 52,
            salesCount: 20,
            rentalCount: 14,
            ...overrides?.summary,
        },
        ...overrides,
    };
}

function makeExportData(
    district: string,
    overrides?: {
        marketGrossYield?: number;
        marketNetYield?: number;
    }
): DashboardExport {
    return {
        meta: {
            generatedAt: "2026-04-03T00:00:00.000Z",
            version: "1.0",
            filters: {
                estateType: "flat",
                constructionType: "brick",
                disposition: "2+kk",
                periods: [],
                district: {
                    name: district,
                    reasId: 10,
                    srealityId: 20,
                    srealityLocality: "district",
                },
                providers: ["reas", "sreality"],
            },
            target: {
                price: 5000000,
                area: 80,
                disposition: "2+kk",
                constructionType: "brick",
                monthlyRent: 22000,
                monthlyCosts: 4000,
                district,
                districtId: 10,
                srealityDistrictId: 20,
            },
            providers: ["reas", "sreality"],
        },
        listings: {
            sold: [],
            activeSales: [
                {
                    disposition: "2+kk",
                    area: 80,
                    price: 5200000,
                    pricePerM2: 125000,
                    address: district,
                    link: "https://example.com",
                    source: "sreality",
                },
            ],
            rentals: [],
        },
        analysis: {
            comparables: {
                median: 120000,
                mean: 121000,
                p25: 115000,
                p75: 126000,
                count: 20,
                targetPercentile: 52,
            },
            trends: [],
            yield: {
                grossYield: 4.5,
                netYield: 3.8,
                paybackYears: 22,
                atMarketPrice: {
                    price: 5000000,
                    grossYield: overrides?.marketGrossYield ?? 4.2,
                    netYield: overrides?.marketNetYield ?? 3.5,
                    paybackYears: 24,
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
                medianDiscount: 1.2,
                maxDiscount: 4.2,
            },
            investmentScore: {
                overall: 68,
                grade: "B",
                reasoning: [],
                recommendation: "Hold",
            },
            momentum: {
                direction: "up",
                priceVelocity: 2.2,
                momentum: "steady",
                confidence: "medium",
                interpretation: "Healthy pricing",
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

describe("district comparison models", () => {
    test("buildDistrictPriceBarModel sorts districts by median price and builds target markers", () => {
        const model = buildDistrictPriceBarModel({
            comparisons: [
                makeComparison({
                    district: "Praha 3",
                    summary: {
                        medianPricePerM2: 116000,
                        grossYield: 4.1,
                        netYield: 3.4,
                        daysOnMarket: 36,
                        targetPercentile: 48,
                        salesCount: 18,
                        rentalCount: 12,
                    },
                }),
                makeComparison({
                    district: "Praha 2",
                    summary: {
                        medianPricePerM2: 122000,
                        grossYield: 4.5,
                        netYield: 3.8,
                        daysOnMarket: 30,
                        targetPercentile: 52,
                        salesCount: 20,
                        rentalCount: 14,
                    },
                }),
            ],
            targetDistrict: "Praha 2",
            targetPricePerM2: 125000,
        });

        expect(model.rows.map((row: { district: string }) => row.district)).toEqual(["Praha 3", "Praha 2"]);
        expect(model.rows[1]?.highlight).toBe(true);
        expect(model.pragueAverage).toBe(119000);
        expect(model.targetPricePerM2).toBe(125000);
    });

    test("buildDistrictYieldBarModel keeps benchmark context and district highlight", () => {
        const model = buildDistrictYieldBarModel({
            comparisons: [
                makeComparison({
                    district: "Praha 2",
                    summary: {
                        medianPricePerM2: 122000,
                        grossYield: 4.5,
                        netYield: 3.8,
                        daysOnMarket: 30,
                        targetPercentile: 52,
                        salesCount: 20,
                        rentalCount: 14,
                    },
                    exportData: makeExportData("Praha 2", { marketGrossYield: 4.2, marketNetYield: 3.5 }),
                }),
                makeComparison({
                    district: "Praha 3",
                    summary: {
                        medianPricePerM2: 116000,
                        grossYield: 4.1,
                        netYield: 3.4,
                        daysOnMarket: 36,
                        targetPercentile: 48,
                        salesCount: 18,
                        rentalCount: 12,
                    },
                    exportData: makeExportData("Praha 3", { marketGrossYield: 3.9, marketNetYield: 3.2 }),
                }),
            ],
            targetDistrict: "Praha 3",
        });

        expect(model.rows[0]).toMatchObject({ district: "Praha 2", grossYield: 4.2, highlight: false });
        expect(model.rows[1]).toMatchObject({ district: "Praha 3", grossYield: 3.9, highlight: true });
        expect(model.benchmarkYield).toBe(4.1);
    });

    test("buildDistrictYieldBarModel uses district market yield instead of target-price yield", () => {
        const model = buildDistrictYieldBarModel({
            comparisons: [
                makeComparison({
                    district: "Praha 2",
                    summary: {
                        medianPricePerM2: 122000,
                        grossYield: 5.1,
                        netYield: 4.2,
                        daysOnMarket: 30,
                        targetPercentile: 52,
                        salesCount: 20,
                        rentalCount: 14,
                    },
                    exportData: makeExportData("Praha 2", { marketGrossYield: 4.2, marketNetYield: 3.5 }),
                }),
                makeComparison({
                    district: "Praha 3",
                    summary: {
                        medianPricePerM2: 116000,
                        grossYield: 4.4,
                        netYield: 3.7,
                        daysOnMarket: 36,
                        targetPercentile: 48,
                        salesCount: 18,
                        rentalCount: 12,
                    },
                    exportData: makeExportData("Praha 3", { marketGrossYield: 3.9, marketNetYield: 3.2 }),
                }),
            ],
            targetDistrict: "Praha 2",
        });

        expect(model.rows[0]).toMatchObject({ district: "Praha 2", grossYield: 4.2, highlight: true });
        expect(model.rows[1]).toMatchObject({ district: "Praha 3", grossYield: 3.9, highlight: false });
        expect(model.benchmarkYield).toBe(4.1);
    });

    test("buildDistrictRadarModel normalizes selected districts across all dimensions", () => {
        const model = buildDistrictRadarModel({
            comparisons: [
                makeComparison({
                    district: "Praha 2",
                    summary: {
                        medianPricePerM2: 122000,
                        grossYield: 4.5,
                        netYield: 3.8,
                        daysOnMarket: 30,
                        targetPercentile: 52,
                        salesCount: 20,
                        rentalCount: 14,
                    },
                    exportData: makeExportData("Praha 2", { marketGrossYield: 4.2, marketNetYield: 3.5 }),
                }),
                makeComparison({
                    district: "Praha 3",
                    summary: {
                        medianPricePerM2: 116000,
                        grossYield: 4.1,
                        netYield: 3.4,
                        daysOnMarket: 36,
                        targetPercentile: 48,
                        salesCount: 18,
                        rentalCount: 12,
                    },
                    exportData: makeExportData("Praha 3", { marketGrossYield: 3.9, marketNetYield: 3.2 }),
                }),
            ],
            selectedDistricts: ["Praha 2", "Praha 3"],
        });

        expect(model.series).toHaveLength(2);
        expect(model.rows[0]).toMatchObject({ metric: "Price", "Praha 2": 0, "Praha 3": 100 });
        expect(model.rows[1]).toMatchObject({ metric: "Yield", "Praha 2": 100, "Praha 3": 0 });
        expect(model.rows[2]).toMatchObject({ metric: "Liquidity", "Praha 2": 100, "Praha 3": 0 });
    });

    test("buildDistrictContextItems returns curated Praha context and generic fallback", () => {
        const items = buildDistrictContextItems(["Praha 2", "Brno"]);

        expect(items[0]).toMatchObject({
            district: "Praha 2",
            title: expect.stringContaining("Praha 2"),
        });
        expect(items[0]?.highlights.length).toBeGreaterThan(0);
        expect(items[1]).toMatchObject({
            district: "Brno",
            title: "Brno market context",
        });
    });
});
