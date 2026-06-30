import { describe, expect, test } from "bun:test";
import {
    type ExtraUsageBucket,
    ExtraUsageBucketTracker,
    formatExtraUsageMessage,
    toMajorAmount,
} from "./extra-usage-tracker";

function extra(overrides: Partial<ExtraUsageBucket> = {}): ExtraUsageBucket {
    return {
        is_enabled: false,
        monthly_limit: 10_000,
        used_credits: null,
        utilization: null,
        currency: "EUR",
        decimal_places: 2,
        ...overrides,
    };
}

describe("toMajorAmount", () => {
    test("converts API minor units to major currency", () => {
        expect(toMajorAmount(1834, 2)).toBe(18.34);
        expect(toMajorAmount(10_000, 2)).toBe(100);
    });
});

describe("ExtraUsageBucketTracker", () => {
    test("notifies on first observation when already enabled", () => {
        const tracker = new ExtraUsageBucketTracker();

        expect(tracker.shouldNotify(extra({ is_enabled: true, used_credits: 1834 }), 1_000)).toEqual({
            reason: "EXTRA_ENABLED",
            fromSpent: null,
            toSpent: 18.34,
            limit: 100,
            currency: "EUR",
            decimalPlaces: 2,
            elapsedMs: null,
        });
    });

    test("notifies on disabled -> enabled transition", () => {
        const tracker = new ExtraUsageBucketTracker();

        tracker.shouldNotify(extra({ is_enabled: false }), 0);

        expect(tracker.shouldNotify(extra({ is_enabled: true, used_credits: 350 }), 1_000)).toEqual({
            reason: "EXTRA_ENABLED",
            fromSpent: null,
            toSpent: 3.5,
            limit: 100,
            currency: "EUR",
            decimalPlaces: 2,
            elapsedMs: null,
        });
    });

    test("disabled notification keeps last known balance when API clears fields", () => {
        const tracker = new ExtraUsageBucketTracker();

        tracker.shouldNotify(extra({ is_enabled: true, used_credits: 1834, monthly_limit: 10_000 }), 0);

        expect(tracker.shouldNotify(extra({ is_enabled: false }), 1_000)).toEqual({
            reason: "EXTRA_DISABLED",
            fromSpent: 18.34,
            toSpent: 18.34,
            limit: 100,
            currency: "EUR",
            decimalPlaces: 2,
            elapsedMs: null,
        });
    });

    test("notifies every 5 EUR spent while enabled", () => {
        const tracker = new ExtraUsageBucketTracker();

        tracker.shouldNotify(extra({ is_enabled: false }), 0);
        tracker.shouldNotify(extra({ is_enabled: true, used_credits: 800 }), 1_000);

        expect(tracker.shouldNotify(extra({ is_enabled: true, used_credits: 1200 }), 60_000)).toBeNull();
        expect(tracker.shouldNotify(extra({ is_enabled: true, used_credits: 1350 }), 3_600_000)).toEqual({
            reason: "EXTRA_SPEND",
            fromSpent: 8,
            toSpent: 13.5,
            limit: 100,
            currency: "EUR",
            decimalPlaces: 2,
            elapsedMs: 3_599_000,
        });
    });
});

describe("formatExtraUsageMessage", () => {
    test("formats live extra-usage-enabled values", () => {
        const message = formatExtraUsageMessage({
            accountName: "acme",
            event: {
                reason: "EXTRA_ENABLED",
                fromSpent: null,
                toSpent: 18.34,
                limit: 100,
                currency: "EUR",
                decimalPlaces: 2,
                elapsedMs: null,
            },
        });

        expect(message).toBe("acme: Extra usage enabled — €18.34/€100.00");
    });
});
