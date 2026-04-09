import { describe, expect, test } from "bun:test";
import type { DashboardExport } from "@app/Internal/commands/reas/lib/api-export";
import {
    GRADE_COLORS,
    getMomentumCardModel,
    getScoreCardModel,
} from "@app/Internal/commands/reas/ui/src/components/analysis/display-model";

function makeExport(): DashboardExport {
    return {
        meta: {
            generatedAt: "2026-04-03T10:00:00.000Z",
            version: "1.0",
            filters: {
                estateType: "flat",
                constructionType: "brick",
                disposition: "2+kk",
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
            providers: ["reas", "sreality"],
        },
        listings: { sold: [], activeSales: [], rentals: [] },
        analysis: {
            comparables: { median: 120000, mean: 121000, p25: 114000, p75: 128000, count: 16, targetPercentile: 38 },
            trends: [
                { period: "Q4 2025", medianPricePerM2: 118000, count: 8, qoqChange: 1.2 },
                { period: "Q1 2026", medianPricePerM2: 120000, count: 8, qoqChange: 1.7 },
            ],
            yield: {
                grossYield: 4.9,
                netYield: 3.8,
                paybackYears: 26.3,
                atMarketPrice: { price: 7700000, grossYield: 4.7, netYield: 3.5, paybackYears: 27.9 },
            },
            timeOnMarket: { median: 44, mean: 48, min: 10, max: 120 },
            discount: { avgDiscount: -3.2, medianDiscount: -2.8, maxDiscount: -9 },
            investmentScore: {
                overall: 82,
                grade: "A",
                reasoning: ["Yield spread is strong", "Trend remains positive"],
                recommendation: "strong-buy",
            },
            momentum: {
                direction: "rising",
                priceVelocity: 2.4,
                momentum: "accelerating",
                confidence: "high",
                interpretation: "Demand is compounding",
            },
            priceHistogram: [],
            domDistribution: [],
            scatter: [],
        },
        benchmarks: { mf: [], investmentBenchmarks: [] },
    };
}

describe("analysis display model", () => {
    test("uses exported investment score instead of recomputing client-side", () => {
        const model = getScoreCardModel(makeExport());

        expect(model.grade).toBe("A");
        expect(model.score).toBe(82);
        expect(model.recommendationLabel).toBe("Strong Buy");
        expect(model.reasoning).toEqual(["Yield spread is strong", "Trend remains positive"]);
    });

    test("uses exported momentum and confidence mapping", () => {
        const model = getMomentumCardModel(makeExport());

        expect(model.directionLabel).toBe("Rising");
        expect(model.velocityPerPeriodLabel).toBe("+2.4% per period");
        expect(model.momentumLabel).toBe("Accelerating");
        expect(model.confidencePercent).toBe(85);
        expect(model.interpretation).toBe("Demand is compounding");
    });

    test("shares canonical grade colors across screens", () => {
        expect(GRADE_COLORS.A).toContain("emerald");
        expect(GRADE_COLORS.F).toContain("red");
    });
});
