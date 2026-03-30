import { describe, expect, test } from "bun:test";
import { SafeJSON } from "@app/utils/json";
import type { FullAnalysis } from "../lib/api-export";
import { buildDashboardExport } from "../lib/api-export";

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

    test("includes time on market stats", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.analysis.timeOnMarket.median).toBe(45);
    });

    test("includes discount stats", () => {
        const result = buildDashboardExport(mockAnalysis);
        expect(result.analysis.discount.avgDiscount).toBe(-3.5);
    });
});
