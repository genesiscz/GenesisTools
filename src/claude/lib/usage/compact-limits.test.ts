import { describe, expect, test } from "bun:test";
import type { UsageResponse } from "./api";
import { effectiveLeftPct, extractCompactLimits } from "./compact-limits";

const NOW = new Date("2026-07-24T20:00:00.000Z");

function usageWithLimits(limits: UsageResponse["limits"]): UsageResponse {
    return {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
        limits,
    };
}

describe("effectiveLeftPct", () => {
    test("a missing limit is unconstrained", () => {
        expect(effectiveLeftPct(undefined, NOW)).toBe(100);
    });

    test("an exhausted bucket whose reset already passed reads as fresh", () => {
        const limit = { leftPct: 0, resetsAt: "2026-07-24T19:59:00.000Z" };
        expect(effectiveLeftPct(limit, NOW)).toBe(100);
    });

    test("an exhausted bucket with a future reset stays exhausted", () => {
        const limit = { leftPct: 0, resetsAt: "2026-07-24T20:30:00.000Z" };
        expect(effectiveLeftPct(limit, NOW)).toBe(0);
    });

    test("a malformed resets_at falls back to the raw headroom", () => {
        const limit = { leftPct: 42, resetsAt: "not-a-date" };
        expect(effectiveLeftPct(limit, NOW)).toBe(42);
    });

    test("no reset scheduled keeps the raw headroom", () => {
        expect(effectiveLeftPct({ leftPct: 17, resetsAt: null }, NOW)).toBe(17);
    });
});

describe("extractCompactLimits", () => {
    test("reads session, weekly_all and the Fable-scoped weekly bucket", () => {
        const compact = extractCompactLimits(
            usageWithLimits([
                { kind: "session", percent: 30, severity: "normal", resets_at: null, scope: null, is_active: true },
                { kind: "weekly_all", percent: 40, severity: "normal", resets_at: null, scope: null, is_active: true },
                {
                    kind: "weekly_scoped",
                    percent: 90,
                    severity: "critical",
                    resets_at: null,
                    scope: { model: { id: "claude-fable-5", display_name: "Fable" }, surface: null },
                    is_active: true,
                },
            ])
        );

        expect(compact.session?.leftPct).toBe(70);
        expect(compact.weekly?.leftPct).toBe(60);
        expect(compact.fable?.leftPct).toBe(10);
    });

    test("a non-Fable scoped weekly bucket is not mistaken for Fable", () => {
        const compact = extractCompactLimits(
            usageWithLimits([
                {
                    kind: "weekly_scoped",
                    percent: 90,
                    severity: "warning",
                    resets_at: null,
                    scope: { model: { id: "claude-opus-5", display_name: "Opus" }, surface: null },
                    is_active: true,
                },
            ])
        );

        expect(compact.fable).toBeUndefined();
    });

    test("falls back to the legacy flat buckets when limits[] is absent", () => {
        const compact = extractCompactLimits({
            five_hour: { utilization: 25, resets_at: "2026-07-24T21:00:00.000Z" },
            seven_day: { utilization: 75, resets_at: null },
        });

        expect(compact.session?.leftPct).toBe(75);
        expect(compact.weekly?.leftPct).toBe(25);
    });
});
