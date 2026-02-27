import { describe, expect, test } from "bun:test";
import {
    calculateRate,
    calculateRollingRates,
    projectTimeToLimit,
    type TimestampedValue,
} from "./rate-math";

describe("calculateRate", () => {
    test("returns rate per minute from two points", () => {
        const rate = calculateRate(
            { timestamp: "2026-02-27T14:00:00Z", value: 40 },
            { timestamp: "2026-02-27T14:05:00Z", value: 45 }
        );
        expect(rate).toBe(1);
    });

    test("returns 0 for same timestamp", () => {
        const rate = calculateRate(
            { timestamp: "2026-02-27T14:00:00Z", value: 40 },
            { timestamp: "2026-02-27T14:00:00Z", value: 45 }
        );
        expect(rate).toBe(0);
    });

    test("handles negative rate (utilization decrease after reset)", () => {
        const rate = calculateRate(
            { timestamp: "2026-02-27T14:00:00Z", value: 80 },
            { timestamp: "2026-02-27T14:05:00Z", value: 5 }
        );
        expect(rate).toBe(-15);
    });
});

describe("calculateRollingRates", () => {
    test("calculates rates for multiple windows", () => {
        const now = new Date("2026-02-27T14:30:00Z");
        const data: TimestampedValue[] = [
            { timestamp: "2026-02-27T13:59:00Z", value: 10 },
            { timestamp: "2026-02-27T14:20:00Z", value: 30 },
            { timestamp: "2026-02-27T14:25:00Z", value: 35 },
            { timestamp: "2026-02-27T14:29:00Z", value: 39 },
            { timestamp: "2026-02-27T14:30:00Z", value: 40 },
        ];

        const rates = calculateRollingRates(data, now);
        expect(rates).toHaveProperty("1min");
        expect(rates).toHaveProperty("5min");
        expect(rates).toHaveProperty("10min");
        expect(rates).toHaveProperty("30min");
    });

    test("returns null rates when insufficient data", () => {
        const rates = calculateRollingRates([], new Date());
        expect(rates["1min"]).toBeNull();
    });
});

describe("projectTimeToLimit", () => {
    test("projects minutes until 100% at given rate", () => {
        const minutes = projectTimeToLimit(40, 1);
        expect(minutes).toBe(60);
    });

    test("returns null for zero or negative rate", () => {
        expect(projectTimeToLimit(40, 0)).toBeNull();
        expect(projectTimeToLimit(40, -1)).toBeNull();
    });

    test("returns 0 if already at or above 100%", () => {
        expect(projectTimeToLimit(100, 1)).toBe(0);
        expect(projectTimeToLimit(105, 1)).toBe(0);
    });
});
