import { describe, expect, test } from "bun:test";
import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { buildMarkdownReportFromExport } from "@app/Internal/commands/reas/lib/pdf-export";

describe("buildMarkdownReportFromExport", () => {
    test("produces valid markdown", () => {
        const data: DashboardExport = {
            meta: {
                generatedAt: "2026-04-02T00:00:00.000Z",
                version: "1.0",
                filters: {
                    estateType: "flat",
                    constructionType: "brick",
                    periods: [],
                    district: { name: "Praha 2", reasId: 1, srealityId: 2, srealityLocality: "district" },
                },
                target: {
                    price: 3500000,
                    area: 65,
                    disposition: "2+kk",
                    constructionType: "brick",
                    monthlyRent: 15000,
                    monthlyCosts: 5000,
                    district: "Praha 2",
                    districtId: 1,
                    srealityDistrictId: 2,
                },
                providers: ["reas", "sreality"],
                providerSummary: [],
            },
            listings: {
                sold: [],
                activeSales: [],
                rentals: [],
            },
            analysis: {
                comparables: { median: 55000, mean: 56000, p25: 50000, p75: 60000, count: 10, targetPercentile: 42 },
                trends: [],
                yield: {
                    grossYield: 5.2,
                    netYield: 3.8,
                    paybackYears: 26,
                    atMarketPrice: { price: 3300000, grossYield: 5.5, netYield: 4, paybackYears: 25 },
                },
                timeOnMarket: { median: 45, mean: 52, min: 10, max: 120 },
                discount: { avgDiscount: -3.5, medianDiscount: -2.8, maxDiscount: -12 },
                investmentScore: {
                    overall: 81,
                    grade: "A",
                    reasoning: ["Healthy yield"],
                    recommendation: "buy",
                },
                momentum: {
                    direction: "rising",
                    priceVelocity: 1.8,
                    momentum: "accelerating",
                    confidence: "high",
                    interpretation: "Growing market",
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

        const markdown = buildMarkdownReportFromExport(data);

        expect(markdown).toContain("# REAS Investment Analysis Report");
        expect(markdown).toContain("Praha 2");
        expect(markdown).toContain("Investment Score: A");
    });
});
