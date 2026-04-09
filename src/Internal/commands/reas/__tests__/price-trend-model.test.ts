import { describe, expect, test } from "bun:test";
import { buildPriceTrendModel } from "@app/Internal/commands/reas/ui/src/components/price-trend-model";

describe("buildPriceTrendModel", () => {
    test("computes yoy label from first and last trend points", () => {
        const model = buildPriceTrendModel([
            { period: "Q4 2025", medianPricePerM2: 100000, count: 8, qoqChange: 1.2 },
            { period: "Q1 2026", medianPricePerM2: 108000, count: 9, qoqChange: 2.4 },
        ]);

        expect(model.isEmpty).toBe(false);
        expect(model.yoyChange).toBe(8);
        expect(model.yoyLabel).toBe("+8.0%");
    });

    test("returns empty state when no trend points exist", () => {
        const model = buildPriceTrendModel([]);

        expect(model.isEmpty).toBe(true);
        expect(model.yoyLabel).toBe("N/A");
        expect(model.points).toEqual([]);
    });
});
