import { describe, expect, test } from "bun:test";
import type { FullAnalysis } from "@app/Internal/commands/reas/lib/api-export";
import { buildDashboardExport, isDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { SafeJSON } from "@app/utils/json";

describe("buildDashboardExport()", () => {
    const mockAnalysis: FullAnalysis = {
        comparables: {
            pricePerM2: { median: 55_000, mean: 57_000, p25: 48_000, p75: 62_000, min: 40_000, max: 75_000 },
            targetPercentile: 45,
            listings: [],
        },
        trends: { periods: [], yoyChange: 5.2, direction: "rising" as const },
        timeOnMarket: { median: 45, mean: 52, min: 10, max: 120, count: 15 },
        discount: {
            avgDiscount: -3.5,
            medianDiscount: -2.8,
            maxDiscount: -12,
            noDiscountCount: 3,
            totalCount: 15,
            discounts: [],
        },
        yield: {
            grossYield: 5.2,
            netYield: 3.8,
            paybackYears: 26,
            atMarketPrice: { price: 3_300_000, grossYield: 5.5, netYield: 4.0, paybackYears: 25 },
            benchmarks: [],
        },
        rentalListings: [],
        saleListings: [],
        mfBenchmarks: [],
        filters: {
            estateType: "flat" as const,
            constructionType: "panel",
            periods: [],
            district: { name: "Praha", reasId: 3100, srealityId: 1, srealityLocality: "district" as const },
        },
        target: {
            price: 3_500_000,
            area: 65,
            disposition: "2+kk",
            constructionType: "panel",
            monthlyRent: 15_000,
            monthlyCosts: 5_000,
            district: "Praha",
            districtId: 3100,
            srealityDistrictId: 1,
        },
        investmentScore: {
            overall: 81,
            grade: "A",
            factors: { yieldScore: 80, discountScore: 82, trendScore: 79, marketVelocityScore: 83 },
            reasoning: ["Healthy yield"],
            recommendation: "buy",
        },
        momentum: {
            priceVelocity: 1.8,
            direction: "rising",
            momentum: "accelerating",
            confidence: "high",
            interpretation: "Growing market",
        },
        providerSummary: [
            {
                provider: "sreality",
                sourceContract: "sreality-v2",
                count: 0,
                fetchedAt: "2026-04-02T00:00:00.000Z",
            },
        ],
    };

    test("produces valid DashboardExport structure", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.meta.version).toBe("1.0");
        expect(result.meta.generatedAt).toBeTruthy();
        expect(result.analysis.comparables.median).toBe(55_000);
    });

    test("includes target property in meta", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.meta.target.price).toBe(3_500_000);
        expect(result.meta.providerSummary).toHaveLength(1);
    });

    test("serializes to valid JSON", () => {
        const result = buildDashboardExport(mockAnalysis);
        const json = SafeJSON.stringify(result);
        expect(() => SafeJSON.parse(json)).not.toThrow();
    });

    test("includes yield data", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.analysis.yield.grossYield).toBe(5.2);
        expect(result.analysis.yield.netYield).toBe(3.8);
    });

    test("includes score and momentum data", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.analysis.investmentScore?.grade).toBe("A");
        expect(result.analysis.momentum?.direction).toBe("rising");
    });

    test("includes time on market stats", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.analysis.timeOnMarket.median).toBe(45);
    });

    test("includes discount stats", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.analysis.discount.avgDiscount).toBe(-3.5);
    });

    test("preserves rental listing provider sources", () => {
        const result = buildDashboardExport({
            ...mockAnalysis,
            rentalListings: [
                {
                    id: "rental-1",
                    source: "bezrealitky",
                    sourceId: "rental-1",
                    sourceContract: "bezrealitky-v1",
                    type: "rental",
                    price: 21_000,
                    locality: "Praha 2",
                    disposition: "2+kk",
                    area: 54,
                    link: "https://example.com/rental-1",
                    labels: [],
                },
            ],
        });

        expect(result.listings.rentals).toHaveLength(1);
        expect(result.listings.rentals[0]?.source).toBe("bezrealitky");
    });

    test("recognizes valid dashboard export payloads", () => {
        const result = buildDashboardExport(mockAnalysis);

        expect(isDashboardExport(result)).toBe(true);
    });

    test("rejects malformed dashboard export payloads", () => {
        expect(isDashboardExport({})).toBe(false);
        expect(isDashboardExport({ meta: {} })).toBe(false);
    });
});
