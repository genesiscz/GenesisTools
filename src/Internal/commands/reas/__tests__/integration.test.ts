import { describe, expect, test } from "bun:test";
import type { FullAnalysis } from "@app/Internal/commands/reas/lib/api-export";
import { buildDashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { SafeJSON } from "@app/utils/json";

describe("integration: full analysis → JSON export pipeline", () => {
    const mockAnalysis: FullAnalysis = {
        comparables: {
            pricePerM2: { median: 55_000, mean: 57_000, p25: 48_000, p75: 62_000, min: 40_000, max: 75_000 },
            targetPercentile: 45,
            listings: [
                {
                    _id: "test-1",
                    disposition: "2+kk",
                    displayArea: 65,
                    utilityArea: 60,
                    soldPrice: 3_300_000,
                    price: 3_400_000,
                    originalPrice: 3_500_000,
                    pricePerM2: 55_000,
                    formattedAddress: "Vinohradská 10, Praha 2",
                    formattedLocation: "Praha 2",
                    soldAt: "2025-06-15",
                    firstVisibleAt: "2025-05-16",
                    daysOnMarket: 30,
                    discount: -3.5,
                    link: "https://example.com/1",
                    point: { type: "Point", coordinates: [14.43, 50.07] },
                    cadastralAreaSlug: "vinohrady",
                    municipalitySlug: "praha",
                },
            ],
        },
        trends: {
            periods: [
                { label: "2025-Q1", medianPerM2: 53_000, count: 12, change: null },
                { label: "2025-Q2", medianPerM2: 55_000, count: 15, change: 3.8 },
            ],
            yoyChange: 5.2,
            direction: "rising" as const,
        },
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
        rentalListings: [
            {
                id: "sreality-101",
                source: "sreality",
                sourceId: "101",
                sourceContract: "sreality-v2",
                type: "rental",
                hash_id: 101,
                name: "Pronájem bytu 2+kk 60 m²",
                price: 15_000,
                disposition: "2+kk",
                area: 60,
                locality: "Praha 2, Vinohrady",
                link: "https://sreality.cz/101",
                gps: { lat: 50.07, lon: 14.43 },
                labels: [],
            },
        ],
        saleListings: [
            {
                id: "sale-1",
                source: "sreality",
                sourceId: "201",
                sourceContract: "sreality-v2",
                type: "sale",
                price: 4200000,
                address: "Praha 2, Vinohrady",
                disposition: "2+kk",
                area: 62,
                pricePerM2: 67742,
                link: "https://sreality.cz/201",
            },
        ],
        mfBenchmarks: [],
        filters: {
            estateType: "flat" as const,
            constructionType: "panel",
            periods: [],
            district: { name: "Praha 2", reasId: 3100, srealityId: 1, srealityLocality: "district" as const },
        },
        target: {
            price: 3_500_000,
            area: 65,
            disposition: "2+kk",
            constructionType: "panel",
            monthlyRent: 15_000,
            monthlyCosts: 5_000,
            district: "Praha 2",
            districtId: 3100,
            srealityDistrictId: 1,
        },
        investmentScore: {
            overall: 72,
            grade: "B",
            factors: { yieldScore: 65, discountScore: 70, trendScore: 80, marketVelocityScore: 75 },
            reasoning: ["Solid yield above bonds"],
            recommendation: "buy",
        },
        momentum: {
            priceVelocity: 2.5,
            direction: "rising",
            momentum: "accelerating",
            confidence: "high",
            interpretation: "Market momentum is accelerating",
        },
        providerSummary: [
            {
                provider: "sreality",
                sourceContract: "sreality-v2",
                count: 2,
                fetchedAt: "2026-04-02T00:00:00.000Z",
            },
        ],
    };

    test("produces valid DashboardExport with all sections", () => {
        const result = buildDashboardExport(mockAnalysis);

        // Meta
        expect(result.meta.version).toBe("1.0");
        expect(result.meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(result.meta.target.price).toBe(3_500_000);

        // Listings
        expect(result.listings.sold).toHaveLength(1);
        expect(result.listings.sold[0].area).toBe(60); // utilityArea preferred
        expect(result.listings.rentals).toHaveLength(1);
        expect(result.listings.rentals[0].rent).toBe(15_000);
        expect(result.listings.activeSales).toHaveLength(1);

        // Analysis
        expect(result.analysis.comparables.median).toBe(55_000);
        expect(result.analysis.comparables.count).toBe(1);
        expect(result.analysis.activeVsSold?.askingPremiumPct).toBeCloseTo(23.167272727272728);
        expect(result.analysis.trends).toHaveLength(2);
        expect(result.analysis.yield.grossYield).toBe(5.2);
        expect(result.analysis.yield.netYield).toBe(3.8);
        expect(result.analysis.timeOnMarket.median).toBe(45);
        expect(result.analysis.discount.avgDiscount).toBe(-3.5);
        expect(result.analysis.investmentScore?.grade).toBe("B");
        expect(result.analysis.momentum?.direction).toBe("rising");
        expect(result.analysis.priceHistogram.length).toBeGreaterThan(0);
        expect(result.analysis.scatter.length).toBe(1);
        expect(result.meta.providerSummary).toHaveLength(1);

        // Benchmarks
        expect(result.benchmarks.investmentBenchmarks).toHaveLength(3);
    });

    test("round-trips through JSON without data loss", () => {
        const result = buildDashboardExport(mockAnalysis);
        const json = SafeJSON.stringify(result);
        const parsed = SafeJSON.parse(json);

        expect(parsed.meta.version).toBe("1.0");
        expect(parsed.analysis.comparables.median).toBe(55_000);
        expect(parsed.analysis.yield.grossYield).toBe(5.2);
        expect(parsed.listings.sold).toHaveLength(1);
        expect(parsed.listings.rentals).toHaveLength(1);
        expect(parsed.listings.activeSales).toHaveLength(1);
        expect(parsed.benchmarks.investmentBenchmarks).toHaveLength(3);
    });

    test("handles empty listings gracefully", () => {
        const emptyAnalysis: FullAnalysis = {
            ...mockAnalysis,
            comparables: { ...mockAnalysis.comparables, listings: [] },
            rentalListings: [],
        };

        const result = buildDashboardExport(emptyAnalysis);

        expect(result.listings.sold).toHaveLength(0);
        expect(result.listings.rentals).toHaveLength(0);
        expect(result.listings.activeSales).toHaveLength(1);
        expect(result.analysis.comparables.count).toBe(0);
        expect(result.analysis.comparables.median).toBe(55_000); // stats still from pricePerM2
    });
});
