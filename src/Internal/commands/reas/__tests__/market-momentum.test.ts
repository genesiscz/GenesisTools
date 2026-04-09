import { describe, expect, test } from "bun:test";
import { detectMomentum } from "@app/Internal/commands/reas/analysis/market-momentum";

describe("detectMomentum()", () => {
    test("detects accelerating rise", () => {
        // Each quarter grows more than previous
        const periods = [
            { medianPerM2: 50_000, count: 10 },
            { medianPerM2: 52_000, count: 12 }, // +4%
            { medianPerM2: 55_000, count: 11 }, // +5.8%
            { medianPerM2: 59_000, count: 13 }, // +7.3%
        ];

        const result = detectMomentum(periods);
        expect(result.direction).toBe("rising");
        expect(result.momentum).toBe("accelerating");
    });

    test("detects decelerating rise", () => {
        const periods = [
            { medianPerM2: 50_000, count: 10 },
            { medianPerM2: 55_000, count: 12 }, // +10%
            { medianPerM2: 57_000, count: 11 }, // +3.6%
            { medianPerM2: 58_000, count: 13 }, // +1.8%
        ];

        const result = detectMomentum(periods);
        expect(result.direction).toBe("rising");
        expect(result.momentum).toBe("decelerating");
    });

    test("returns low confidence with < 3 periods", () => {
        const periods = [{ medianPerM2: 50_000, count: 10 }];
        const result = detectMomentum(periods);
        expect(result.confidence).toBe("low");
    });

    test("detects stable market", () => {
        const periods = [
            { medianPerM2: 50_000, count: 10 },
            { medianPerM2: 50_200, count: 12 }, // +0.4%
            { medianPerM2: 50_100, count: 11 }, // -0.2%
            { medianPerM2: 50_300, count: 13 }, // +0.4%
        ];

        const result = detectMomentum(periods);
        expect(result.direction).toBe("stable");
    });

    test("detects declining market", () => {
        const periods = [
            { medianPerM2: 60_000, count: 10 },
            { medianPerM2: 57_000, count: 12 }, // -5%
            { medianPerM2: 54_000, count: 11 }, // -5.3%
            { medianPerM2: 51_000, count: 13 }, // -5.6%
        ];

        const result = detectMomentum(periods);
        expect(result.direction).toBe("declining");
    });

    test("returns high confidence with 4+ periods and 30+ samples", () => {
        const periods = [
            { medianPerM2: 50_000, count: 10 },
            { medianPerM2: 52_000, count: 10 },
            { medianPerM2: 54_000, count: 10 },
            { medianPerM2: 56_000, count: 10 },
        ];

        const result = detectMomentum(periods);
        expect(result.confidence).toBe("high");
    });

    test("includes interpretation string", () => {
        const periods = [
            { medianPerM2: 50_000, count: 10 },
            { medianPerM2: 55_000, count: 12 },
        ];

        const result = detectMomentum(periods);
        expect(result.interpretation.length).toBeGreaterThan(0);
    });

    test("handles 2 periods", () => {
        const periods = [
            { medianPerM2: 50_000, count: 10 },
            { medianPerM2: 55_000, count: 12 },
        ];

        const result = detectMomentum(periods);
        expect(result.priceVelocity).toBeGreaterThan(0);
        expect(result.direction).toBe("rising");
    });
});
