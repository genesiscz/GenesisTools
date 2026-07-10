import { describe, expect, test } from "bun:test";
import { scoreAccounts } from "./account-picker";
import type { AccountUsage, UsageResponse } from "./api";

const NOW = new Date("2026-07-10T12:00:00Z");

function hoursFromNow(hours: number): string {
    return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

function usage(overrides: Partial<UsageResponse>): UsageResponse {
    return {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
        ...overrides,
    };
}

function account(name: string, usageData?: UsageResponse, error?: string): AccountUsage {
    return { accountName: name, usage: usageData, error };
}

describe("scoreAccounts — canonical user scenarios", () => {
    test("S1: 90%-used weekly resetting in 10h beats 80%-used 5h session with far weekly reset", () => {
        const a = account(
            "a",
            usage({
                five_hour: { utilization: 80, resets_at: hoursFromNow(1) },
                seven_day: { utilization: 40, resets_at: hoursFromNow(96) },
            })
        );
        const b = account(
            "b",
            usage({
                seven_day: { utilization: 90, resets_at: hoursFromNow(10) },
            })
        );

        const ranked = scoreAccounts([a, b], { now: NOW });
        expect(ranked[0].accountName).toBe("b");
        // A: 60/96 = 0.625 %/h, B: 10/10 = 1.0 %/h
        expect(ranked[0].weeklyRatePctPerHour).toBeCloseTo(1.0, 2);
        expect(ranked[1].weeklyRatePctPerHour).toBeCloseTo(0.625, 2);
    });

    test("S2: same accounts, but A's weekly resets in 9h -> A wins despite 80%-used session", () => {
        const a = account(
            "a",
            usage({
                five_hour: { utilization: 80, resets_at: hoursFromNow(1) },
                seven_day: { utilization: 40, resets_at: hoursFromNow(9) },
            })
        );
        const b = account(
            "b",
            usage({
                seven_day: { utilization: 90, resets_at: hoursFromNow(10) },
            })
        );

        const ranked = scoreAccounts([a, b], { now: NOW });
        expect(ranked[0].accountName).toBe("a");
        // A: 60/9 ≈ 6.7 %/h
        expect(ranked[0].weeklyRatePctPerHour).toBeCloseTo(60 / 9, 2);
    });

    test("Ex3: 90%-used 5h resetting in 2h is session-starved (below pace-line), loses to fresh session", () => {
        const starved = account(
            "starved",
            usage({
                five_hour: { utilization: 90, resets_at: hoursFromNow(2) },
                seven_day: { utilization: 50, resets_at: hoursFromNow(24) },
            })
        );
        const fresh = account(
            "fresh",
            usage({
                seven_day: { utilization: 80, resets_at: hoursFromNow(72) },
            })
        );

        const ranked = scoreAccounts([starved, fresh], { now: NOW });
        // starved has the better weekly rate (50/24 ≈ 2.1 vs 20/72 ≈ 0.28)
        // but the starvation gate demotes it: 10% left < pace-line 40%
        expect(ranked[0].accountName).toBe("fresh");
        expect(ranked[1].tier).toBe("session-starved");
    });

    test("Ex4: 70%-used resetting in 2h (starved) loses to 90%-used resetting in 10min (imminent refill)", () => {
        const x = account(
            "x",
            usage({
                five_hour: { utilization: 70, resets_at: hoursFromNow(2) },
                seven_day: { utilization: 50, resets_at: hoursFromNow(48) },
            })
        );
        const y = account(
            "y",
            usage({
                five_hour: { utilization: 90, resets_at: hoursFromNow(1 / 6) },
                seven_day: { utilization: 50, resets_at: hoursFromNow(48) },
            })
        );

        const ranked = scoreAccounts([x, y], { now: NOW });
        // Equal weekly rates; X delivers only 30% of its 40% pace-line (~75% usable),
        // Y is fully usable (refill in 10 min) -> usable-fraction tiebreak picks Y
        expect(ranked[0].accountName).toBe("y");
        expect(ranked[0].sessionUsableFraction).toBe(1);
        expect(ranked[1].sessionUsableFraction).toBeCloseTo(0.75, 2);
    });

    test("lightly-used bucket right after window open is NOT starved (majority-stall gate)", () => {
        // 8% used with ~4h50m to reset: pace-line ≈ 97%, headroom 92% — a plain
        // below-pace-line gate would demote this perfectly usable account
        const justOpened = account(
            "just-opened",
            usage({
                five_hour: { utilization: 8, resets_at: hoursFromNow(4 + 50 / 60) },
                seven_day: { utilization: 2, resets_at: hoursFromNow(55) },
            })
        );

        const ranked = scoreAccounts([justOpened], { now: NOW });
        expect(ranked[0].tier).toBe("ready");
        expect(ranked[0].sessionUsableFraction).toBeGreaterThan(0.9);
    });
});

describe("scoreAccounts — tiers and edge cases", () => {
    test("use-it-or-lose-it: expiring 90%-used weekly beats completely fresh account", () => {
        const fresh = account("fresh", usage({}));
        const expiring = account("expiring", usage({ seven_day: { utilization: 90, resets_at: hoursFromNow(10) } }));

        const ranked = scoreAccounts([fresh, expiring], { now: NOW });
        expect(ranked[0].accountName).toBe("expiring");
        // fresh baseline: 100/168 ≈ 0.6 %/h < 1.0 %/h
        expect(ranked[1].weeklyRatePctPerHour).toBeCloseTo(100 / 168, 2);
    });

    test("weekly exhausted -> weekly-blocked tier, below ready accounts", () => {
        const blocked = account("blocked", usage({ seven_day: { utilization: 100, resets_at: hoursFromNow(5) } }));
        const ok = account("ok", usage({ seven_day: { utilization: 95, resets_at: hoursFromNow(100) } }));

        const ranked = scoreAccounts([blocked, ok], { now: NOW });
        expect(ranked[0].accountName).toBe("ok");
        expect(ranked[1].tier).toBe("weekly-blocked");
        expect(ranked[1].why).toContain("refills in");
    });

    test("fetch error -> no-data tier, always last", () => {
        const broken = account("broken", undefined, "HTTP 500");
        const ok = account("ok", usage({ seven_day: { utilization: 99, resets_at: hoursFromNow(160) } }));

        const ranked = scoreAccounts([broken, ok], { now: NOW });
        expect(ranked[0].accountName).toBe("ok");
        expect(ranked[1].tier).toBe("no-data");
    });

    test("reset in the past (cache lag) treats bucket as fresh", () => {
        const lagged = account("lagged", usage({ seven_day: { utilization: 95, resets_at: hoursFromNow(-1) } }));

        const ranked = scoreAccounts([lagged], { now: NOW });
        expect(ranked[0].tier).toBe("ready");
        expect(ranked[0].weeklyHeadroomPct).toBe(100);
    });

    test("opus launch binds the worse of seven_day and seven_day_opus", () => {
        const opusHeavy = account(
            "opus-heavy",
            usage({
                seven_day: { utilization: 20, resets_at: hoursFromNow(24) },
                seven_day_opus: { utilization: 95, resets_at: hoursFromNow(24) },
            })
        );
        const balanced = account(
            "balanced",
            usage({
                seven_day: { utilization: 50, resets_at: hoursFromNow(24) },
                seven_day_opus: { utilization: 50, resets_at: hoursFromNow(24) },
            })
        );

        const noModel = scoreAccounts([opusHeavy, balanced], { now: NOW });
        expect(noModel[0].accountName).toBe("opus-heavy");

        const opusLaunch = scoreAccounts([opusHeavy, balanced], { now: NOW, modelFamily: "opus" });
        expect(opusLaunch[0].accountName).toBe("balanced");
        expect(opusLaunch[1].why).toContain("opus wk");
    });

    test("equal weekly rates tiebreak on session headroom", () => {
        const lowSession = account(
            "low-session",
            usage({
                five_hour: { utilization: 60, resets_at: hoursFromNow(2.5) },
                seven_day: { utilization: 50, resets_at: hoursFromNow(50) },
            })
        );
        const highSession = account(
            "high-session",
            usage({
                five_hour: { utilization: 10, resets_at: hoursFromNow(2.5) },
                seven_day: { utilization: 50, resets_at: hoursFromNow(50) },
            })
        );

        const ranked = scoreAccounts([lowSession, highSession], { now: NOW });
        expect(ranked[0].accountName).toBe("high-session");
    });
});
