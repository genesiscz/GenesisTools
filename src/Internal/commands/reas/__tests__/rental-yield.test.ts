import { describe, expect, test } from "bun:test";
import { analyzeRentalYield } from "@app/Internal/commands/reas/analysis/rental-yield";
import type { TargetProperty } from "@app/Internal/commands/reas/types";

const makeTarget = (overrides: Partial<TargetProperty> = {}): TargetProperty => ({
    price: 3_000_000,
    area: 60,
    disposition: "2+kk",
    constructionType: "panel",
    monthlyRent: 15_000,
    monthlyCosts: 5_000,
    district: "Praha",
    districtId: 3100,
    srealityDistrictId: 1,
    ...overrides,
});

describe("analyzeRentalYield()", () => {
    test("computes gross yield correctly", () => {
        const result = analyzeRentalYield(makeTarget(), 50_000, 0);

        // Gross = (15000 * 12 / 3000000) * 100 = 6%
        expect(result.grossYield).toBeCloseTo(6.0, 1);
    });

    test("computes net yield correctly", () => {
        const result = analyzeRentalYield(makeTarget(), 50_000, 0);

        // Net = ((15000 - 5000) * 12 / 3000000) * 100 = 4%
        expect(result.netYield).toBeCloseTo(4.0, 1);
    });

    test("computes payback in years", () => {
        const result = analyzeRentalYield(makeTarget(), 50_000, 0);

        // Payback = 3000000 / ((15000 - 5000) * 12) = 25 years
        expect(result.paybackYears).toBeCloseTo(25, 0);
    });

    test("includes at-market-price scenario", () => {
        const result = analyzeRentalYield(makeTarget(), 50_000, 0);

        // Market price = 50000 * 60 = 3,000,000 (same as target in this case)
        expect(result.atMarketPrice.price).toBe(3_000_000);
    });

    test("uses rental estimate when provided", () => {
        const result = analyzeRentalYield(makeTarget(), 50_000, 20_000);

        // Should use rentalEstimate (20000) instead of target.monthlyRent (15000)
        // Gross = (20000 * 12 / 3000000) * 100 = 8%
        expect(result.grossYield).toBeCloseTo(8.0, 1);
    });

    test("falls back to target rent when estimate is 0", () => {
        const result = analyzeRentalYield(makeTarget(), 50_000, 0);

        // Should use target.monthlyRent (15000)
        expect(result.grossYield).toBeCloseTo(6.0, 1);
    });

    test("includes benchmarks", () => {
        const result = analyzeRentalYield(makeTarget(), 50_000, 0);
        expect(result.benchmarks.length).toBeGreaterThan(0);
        expect(result.benchmarks.some((b) => b.name.includes("bonds"))).toBe(true);
    });

    test("handles zero price gracefully", () => {
        const result = analyzeRentalYield(makeTarget({ price: 0 }), 50_000, 0);
        expect(result.grossYield).toBe(0);
        expect(result.netYield).toBe(0);
    });
});
