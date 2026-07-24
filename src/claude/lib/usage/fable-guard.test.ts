import { describe, expect, test } from "bun:test";
import type { AccountUsage, UsageResponse } from "./api";
import { fableCapableAccounts, fableStatus, fableStatusForAccount } from "./fable-guard";

const NOW = new Date("2026-07-24T20:00:00.000Z");

function hoursFromNow(hours: number): string {
    return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

function usageWith(fablePercentUsed: number | null, weeklyPercentUsed = 10): UsageResponse {
    const limits = [
        {
            kind: "weekly_all",
            percent: weeklyPercentUsed,
            severity: "normal",
            resets_at: hoursFromNow(50),
            scope: null,
            is_active: true,
        },
    ];

    if (fablePercentUsed !== null) {
        limits.push({
            kind: "weekly_scoped",
            percent: fablePercentUsed,
            severity: "normal",
            resets_at: hoursFromNow(50),
            scope: { model: { id: "claude-fable-5", display_name: "Fable" }, surface: null },
            is_active: true,
        } as never);
    }

    return {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: weeklyPercentUsed, resets_at: hoursFromNow(50) },
        limits,
    };
}

describe("fableStatus", () => {
    test("never-polled usage is UNKNOWN and reported available", () => {
        const status = fableStatus(undefined, NOW);
        expect(status.available).toBe(true);
        expect(status.exhausted).toBe(false);
    });

    test("no Fable-scoped limit at all is unconstrained", () => {
        expect(fableStatus(usageWith(null), NOW).available).toBe(true);
    });

    test("a spent Fable bucket is exhausted and unavailable", () => {
        const status = fableStatus(usageWith(99.5), NOW);
        expect(status.available).toBe(false);
        expect(status.exhausted).toBe(true);
    });

    test("a low-but-not-spent bucket is unavailable without being exhausted", () => {
        const status = fableStatus(usageWith(98), NOW);
        expect(status.available).toBe(false);
        expect(status.exhausted).toBe(false);
    });

    test("plenty of headroom is available", () => {
        expect(fableStatus(usageWith(20), NOW).available).toBe(true);
    });

    test("a bucket whose reset already passed reads as fresh", () => {
        const usage: UsageResponse = {
            five_hour: { utilization: 0, resets_at: null },
            seven_day: { utilization: 10, resets_at: null },
            limits: [
                {
                    kind: "weekly_scoped",
                    percent: 100,
                    severity: "critical",
                    resets_at: new Date(NOW.getTime() - 60_000).toISOString(),
                    scope: { model: { id: "claude-fable-5", display_name: "Fable" }, surface: null },
                    is_active: true,
                },
            ],
        };

        expect(fableStatus(usage, NOW).available).toBe(true);
    });
});

describe("fableStatusForAccount", () => {
    test("an account missing from the cache is UNKNOWN, never blocked", () => {
        const accounts: AccountUsage[] = [{ accountName: "other", usage: usageWith(99) }];
        expect(fableStatusForAccount(accounts, "absent", NOW).available).toBe(true);
    });
});

describe("fableCapableAccounts", () => {
    test("lists only accounts with both Fable and weekly headroom", () => {
        const accounts: AccountUsage[] = [
            { accountName: "good", usage: usageWith(10) },
            { accountName: "fable-spent", usage: usageWith(99.9) },
            { accountName: "weekly-dead", usage: usageWith(10, 100) },
            { accountName: "no-data" },
        ];

        expect(fableCapableAccounts(accounts, NOW)).toEqual(["good"]);
    });
});
