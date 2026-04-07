import { describe, expect, test } from "bun:test";
import { computeInvestmentScore } from "@app/Internal/commands/reas/analysis/investment-score";

describe("computeInvestmentScore()", () => {
    test("high yield + discount + rising = A grade", () => {
        const result = computeInvestmentScore({
            netYield: 5.5, // well above bonds (4.2%)
            discount: -8, // 8% below asking
            trendDirection: "rising",
            trendYoY: 6, // 6% annual growth
            medianDaysOnMarket: 25, // fast selling
            districtMedianDays: 45,
        });

        expect(result.grade).toBe("A");
        expect(result.overall).toBeGreaterThanOrEqual(80);
        expect(result.recommendation).toBe("strong-buy");
    });

    test("low yield + premium + declining = D/F grade", () => {
        const result = computeInvestmentScore({
            netYield: 2.0,
            discount: 5, // 5% premium over market
            trendDirection: "declining",
            trendYoY: -3,
            medianDaysOnMarket: 90,
            districtMedianDays: 45,
        });

        expect(["D", "F"]).toContain(result.grade);
        expect(result.overall).toBeLessThan(40);
    });

    test("average everything = B/C grade", () => {
        const result = computeInvestmentScore({
            netYield: 3.8,
            discount: -2,
            trendDirection: "stable",
            trendYoY: 1,
            medianDaysOnMarket: 50,
            districtMedianDays: 45,
        });

        expect(["B", "C"]).toContain(result.grade);
    });

    test("includes reasoning array", () => {
        const result = computeInvestmentScore({
            netYield: 5.0,
            discount: -5,
            trendDirection: "rising",
            trendYoY: 4,
            medianDaysOnMarket: 30,
            districtMedianDays: 45,
        });

        expect(result.reasoning.length).toBeGreaterThan(0);
    });

    test("factors sum to overall within rounding", () => {
        const result = computeInvestmentScore({
            netYield: 4.0,
            discount: -3,
            trendDirection: "rising",
            trendYoY: 3,
            medianDaysOnMarket: 40,
            districtMedianDays: 45,
        });

        // Weighted sum should match overall
        const computed =
            result.factors.yieldScore * 0.3 +
            result.factors.discountScore * 0.25 +
            result.factors.trendScore * 0.25 +
            result.factors.marketVelocityScore * 0.2;

        expect(result.overall).toBeCloseTo(computed, 0);
    });

    test("recommendation matches grade", () => {
        const scenarios = [
            {
                netYield: 6.0,
                discount: -10,
                trendDirection: "rising" as const,
                trendYoY: 8,
                medianDaysOnMarket: 20,
                districtMedianDays: 45,
            },
            {
                netYield: 1.0,
                discount: 10,
                trendDirection: "declining" as const,
                trendYoY: -5,
                medianDaysOnMarket: 100,
                districtMedianDays: 45,
            },
        ];

        for (const input of scenarios) {
            const result = computeInvestmentScore(input);

            if (result.grade === "A") {
                expect(result.recommendation).toBe("strong-buy");
            }

            if (result.grade === "F") {
                expect(result.recommendation).toBe("strong-avoid");
            }
        }
    });

    test("handles zero districtMedianDays without NaN", () => {
        const result = computeInvestmentScore({
            netYield: 4.0,
            discount: -3,
            trendDirection: "stable",
            trendYoY: 0,
            medianDaysOnMarket: 40,
            districtMedianDays: 0,
        });

        expect(Number.isFinite(result.overall)).toBe(true);
        expect(result.overall).toBeGreaterThanOrEqual(0);
        expect(result.overall).toBeLessThanOrEqual(100);
    });
});
