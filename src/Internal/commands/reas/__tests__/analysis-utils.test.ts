import { describe, expect, test } from "bun:test";
import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import { getProviderCounts } from "@app/Internal/commands/reas/ui/src/components/analysis/utils";

function makeExport(providerSummary: NonNullable<DashboardExport["meta"]["providerSummary"]>): DashboardExport {
    return {
        meta: {
            generatedAt: "2026-04-03T10:00:00.000Z",
            version: "1.0",
            filters: {
                estateType: "flat",
                constructionType: "brick",
                district: { name: "Praha 2", reasId: 2, srealityId: 2, srealityLocality: "district" },
                periods: [],
            },
            target: {
                district: "Praha 2",
                districtId: 2,
                srealityDistrictId: 2,
                price: 7500000,
                area: 61,
                disposition: "2+kk",
                constructionType: "brick",
                monthlyRent: 24500,
                monthlyCosts: 4500,
            },
            providers: ["reas", "sreality", "mf"],
            providerSummary,
        },
        listings: { sold: [], activeSales: [], rentals: [] },
        analysis: {
            comparables: { median: 120000, mean: 121000, p25: 114000, p75: 128000, count: 16, targetPercentile: 38 },
            trends: [],
            yield: {
                grossYield: 4.9,
                netYield: 3.8,
                paybackYears: 26.3,
                atMarketPrice: { price: 7700000, grossYield: 4.7, netYield: 3.5, paybackYears: 27.9 },
            },
            timeOnMarket: { median: 44, mean: 48, min: 10, max: 120 },
            discount: { avgDiscount: -3.2, medianDiscount: -2.8, maxDiscount: -9 },
            priceHistogram: [],
            domDistribution: [],
            scatter: [],
        },
        benchmarks: { mf: [], investmentBenchmarks: [] },
    };
}

describe("getProviderCounts()", () => {
    test("does not count zero-row providers as healthy", () => {
        const counts = getProviderCounts(
            makeExport([
                {
                    provider: "reas",
                    sourceContract: "reas-catalog",
                    count: 12,
                    fetchedAt: "2026-04-03T10:00:00.000Z",
                },
                {
                    provider: "sreality",
                    sourceContract: "sreality-v2",
                    count: 0,
                    fetchedAt: "2026-04-03T10:00:00.000Z",
                },
                {
                    provider: "mf",
                    sourceContract: "mf-cenova-mapa",
                    count: 4,
                    fetchedAt: "2026-04-03T10:00:00.000Z",
                },
            ])
        );

        expect(counts.uniqueProviders).toBe(3);
        expect(counts.healthy).toBe(2);
        expect(counts.total).toBe(16);
    });
});
