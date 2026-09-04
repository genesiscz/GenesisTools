import { describe, expect, test } from "bun:test";
import type { UsageResponse } from "./api";
import { normalizeLimits, normalizeSpend } from "./limits";

const sampleWithLimits: UsageResponse = {
    five_hour: { utilization: 34, resets_at: "2026-06-26T15:59:59Z" },
    seven_day: { utilization: 100, resets_at: "2026-06-27T16:59:59Z" },
    seven_day_sonnet: { utilization: 3, resets_at: "2026-06-27T16:59:59Z" },
    seven_day_opus: null,
    limits: [
        {
            kind: "session",
            group: "session",
            percent: 34,
            severity: "warning",
            resets_at: "2026-06-26T15:59:59Z",
            scope: null,
            is_active: true,
        },
        {
            kind: "weekly_all",
            group: "weekly",
            percent: 100,
            severity: "critical",
            resets_at: "2026-06-27T16:59:59Z",
            scope: null,
            is_active: true,
        },
        {
            kind: "weekly_scoped",
            group: "weekly",
            percent: 3,
            severity: "normal",
            resets_at: "2026-06-27T16:59:59Z",
            scope: { model: { id: null, display_name: "Sonnet" }, surface: null },
            is_active: false,
        },
    ],
    spend: {
        used: { amount_minor: 0, currency: "EUR", exponent: 2 },
        limit: { amount_minor: 15000, currency: "EUR", exponent: 2 },
        percent: 0,
        severity: "normal",
        enabled: true,
        cap: { money: { amount_minor: 15000, currency: "EUR", exponent: 2 }, credits: null },
    },
};

describe("normalizeLimits — new-shape (limits[] present)", () => {
    test("maps session/weekly_all/weekly_scoped to canonical bucket keys", () => {
        const result = normalizeLimits(sampleWithLimits);
        const byBucket = Object.fromEntries(result.map((l) => [l.bucket, l]));

        expect(byBucket.five_hour).toEqual({
            bucket: "five_hour",
            percent: 34,
            severity: "warning",
            resets_at: "2026-06-26T15:59:59Z",
            is_active: true,
            scope_model: null,
        });
        expect(byBucket.seven_day).toMatchObject({ percent: 100, severity: "critical" });
        expect(byBucket.seven_day_sonnet).toMatchObject({
            percent: 3,
            severity: "normal",
            scope_model: "Sonnet",
        });
    });

    test("opus row not emitted when limits[] has no Opus scope", () => {
        const result = normalizeLimits(sampleWithLimits);
        expect(result.find((l) => l.bucket === "seven_day_opus")).toBeUndefined();
    });

    test("ignores unknown limit kinds", () => {
        const usage: UsageResponse = {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 0, resets_at: null },
            limits: [
                {
                    kind: "future_unknown",
                    percent: 50,
                    severity: "normal",
                    resets_at: null,
                    scope: null,
                    is_active: false,
                },
            ],
        };
        expect(normalizeLimits(usage)).toEqual([]);
    });
});

describe("normalizeLimits — legacy fallback (no limits[])", () => {
    test("reads flat five_hour / seven_day / seven_day_sonnet fields", () => {
        const legacy: UsageResponse = {
            five_hour: { utilization: 50, resets_at: "X" },
            seven_day: { utilization: 80, resets_at: "Y" },
            seven_day_sonnet: { utilization: 0, resets_at: null },
        };
        const result = normalizeLimits(legacy);
        const byBucket = Object.fromEntries(result.map((l) => [l.bucket, l]));

        expect(byBucket.five_hour).toMatchObject({ percent: 50, severity: "normal" });
        expect(byBucket.seven_day).toMatchObject({ percent: 80, severity: "warning" });
        expect(byBucket.seven_day_sonnet).toMatchObject({ percent: 0, scope_model: "Sonnet" });
    });

    test("derives severity from percent in legacy mode (≥100 critical, ≥80 warning, else normal)", () => {
        const legacy: UsageResponse = {
            five_hour: { utilization: 100, resets_at: "X" },
            seven_day: { utilization: 0, resets_at: null },
        };
        const result = normalizeLimits(legacy);
        const fh = result.find((l) => l.bucket === "five_hour");

        expect(fh?.severity).toBe("critical");
    });
});

describe("normalizeSpend", () => {
    test("extracts used/limit/cap money amounts and severity", () => {
        const result = normalizeSpend(sampleWithLimits);
        expect(result).toEqual({
            used_minor: 0,
            used_currency: "EUR",
            used_exponent: 2,
            limit_minor: 15000,
            limit_exponent: 2,
            percent: 0,
            severity: "normal",
            enabled: true,
            cap_minor: 15000,
            cap_currency: "EUR",
        });
    });

    test("returns null when spend is missing or used is null", () => {
        expect(
            normalizeSpend({
                five_hour: { utilization: 0, resets_at: null },
                seven_day: { utilization: 0, resets_at: null },
            })
        ).toBeNull();
        expect(
            normalizeSpend({
                five_hour: { utilization: 0, resets_at: null },
                seven_day: { utilization: 0, resets_at: null },
                spend: {
                    used: null,
                    limit: null,
                    percent: 0,
                    severity: "normal",
                    enabled: false,
                    cap: null,
                },
            })
        ).toBeNull();
    });
});
