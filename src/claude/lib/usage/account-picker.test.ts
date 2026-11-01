import { describe, expect, test } from "bun:test";
import { scoreAccounts, sortGrouped } from "./account-picker";
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

    test("malformed resets_at is treated as unscheduled, never NaN in ranking", () => {
        const malformed = account("malformed", usage({ seven_day: { utilization: 95, resets_at: "not-a-date" } }));
        const ok = account("ok", usage({ seven_day: { utilization: 50, resets_at: hoursFromNow(24) } }));

        const ranked = scoreAccounts([malformed, ok], { now: NOW });

        for (const acc of ranked) {
            expect(Number.isNaN(acc.weeklyRatePctPerHour)).toBe(false);
        }

        const scored = ranked.find((a) => a.accountName === "malformed");
        expect(scored?.tier).not.toBe("no-data");
        expect(scored?.weeklyHeadroomPct).toBe(5);
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

describe("grouped urgency", () => {
    function fableLimit(percentUsed: number, resetsAt: string | null) {
        return {
            kind: "weekly_scoped",
            percent: percentUsed,
            severity: "normal",
            resets_at: resetsAt,
            scope: { model: { id: "claude-fable-5", display_name: "Fable" }, surface: null },
            is_active: true,
        } as const;
    }

    test("a Fable-exhausted account lands in the opus group", () => {
        const [scored] = scoreAccounts(
            [
                account(
                    "spent",
                    usage({
                        seven_day: { utilization: 20, resets_at: hoursFromNow(50) },
                        limits: [fableLimit(99.5, hoursFromNow(50))],
                    })
                ),
            ],
            { now: NOW }
        );

        expect(scored.group).toBe("opus");
    });

    test("a Fable-capable account stays in the fable group", () => {
        const [scored] = scoreAccounts(
            [
                account(
                    "fresh",
                    usage({
                        seven_day: { utilization: 20, resets_at: hoursFromNow(50) },
                        limits: [fableLimit(10, hoursFromNow(50))],
                    })
                ),
            ],
            { now: NOW }
        );

        expect(scored.group).toBe("fable");
    });

    test("an exhausted weekly bucket is the dead group", () => {
        const [scored] = scoreAccounts(
            [account("dead", usage({ seven_day: { utilization: 99, resets_at: hoursFromNow(20) } }))],
            { now: NOW }
        );

        expect(scored.group).toBe("dead");
    });

    test("invalid_grant is the expired group, a plain fetch error is not", () => {
        const [dead, flaky] = scoreAccounts(
            [
                account("dead-login", undefined, "Token expired (invalid_grant). Run: tools claude login x"),
                account("flaky", undefined, "Usage API 500: upstream boom"),
            ],
            { now: NOW }
        );

        expect(dead.group).toBe("expired");
        expect(flaky.group).toBe("fable");
    });

    test("a nearly spent 5h window marks the account cooling", () => {
        const [scored] = scoreAccounts(
            [
                account(
                    "cooling",
                    usage({
                        five_hour: { utilization: 99, resets_at: hoursFromNow(1) },
                        seven_day: { utilization: 20, resets_at: hoursFromNow(50) },
                    })
                ),
            ],
            { now: NOW }
        );

        expect(scored.cooling).toBe(true);
    });

    // Expired outranks dead: an expired login only kills usage polling (the
    // launcher runs on the long-lived token, and one re-login restores the
    // numbers), while a dead account is out of quota or off a paid plan.
    test("sortGrouped puts fable before opus before expired before dead", () => {
        const scored = scoreAccounts(
            [
                account("dead", usage({ seven_day: { utilization: 99, resets_at: hoursFromNow(20) } })),
                account("expired", undefined, "Token expired (invalid_grant)"),
                account(
                    "opus-only",
                    usage({
                        seven_day: { utilization: 20, resets_at: hoursFromNow(50) },
                        limits: [fableLimit(99.9, hoursFromNow(50))],
                    })
                ),
                account(
                    "fable-ok",
                    usage({
                        seven_day: { utilization: 20, resets_at: hoursFromNow(50) },
                        limits: [fableLimit(5, hoursFromNow(50))],
                    })
                ),
            ],
            { now: NOW }
        );

        expect(sortGrouped(scored).map((s) => s.accountName)).toEqual(["fable-ok", "opus-only", "expired", "dead"]);
    });

    // Both weeks hold more than a nominal pace can burn before their resets, so
    // each will lose its leftover. The one resetting first loses it first, and
    // the other keeps its headroom: "later" has a slightly higher rate here and
    // still ranks second.
    test("sortGrouped burns the surplus week that resets first", () => {
        const scored = scoreAccounts(
            [
                account(
                    "later",
                    usage({
                        five_hour: { utilization: 3, resets_at: hoursFromNow(2) },
                        seven_day: { utilization: 2, resets_at: hoursFromNow(119) },
                    })
                ),
                account(
                    "soon",
                    usage({
                        five_hour: { utilization: 23, resets_at: hoursFromNow(1) },
                        seven_day: { utilization: 66, resets_at: hoursFromNow(43) },
                    })
                ),
            ],
            { now: NOW }
        );

        expect(scored.map((s) => s.accountName)).toEqual(["later", "soon"]);
        expect(sortGrouped(scored).map((s) => s.accountName)).toEqual(["soon", "later"]);
    });

    // A week that a nominal pace empties before its reset wastes nothing, but a
    // session on it stalls before the refill, so a surplus week goes first.
    test("sortGrouped ranks a short week after a surplus week that resets later", () => {
        const scored = scoreAccounts(
            [
                account("short", usage({ seven_day: { utilization: 90, resets_at: hoursFromNow(30) } })),
                account("fresh", usage({ seven_day: { utilization: 5, resets_at: hoursFromNow(150) } })),
            ],
            { now: NOW }
        );

        expect(sortGrouped(scored).map((s) => s.accountName)).toEqual(["fresh", "short"]);
    });

    test("sortGrouped sinks cooling accounts to their group's bottom", () => {
        const scored = scoreAccounts(
            [
                account(
                    "cooling",
                    usage({
                        five_hour: { utilization: 99, resets_at: hoursFromNow(1) },
                        seven_day: { utilization: 10, resets_at: hoursFromNow(10) },
                    })
                ),
                account(
                    "hot",
                    usage({
                        five_hour: { utilization: 10, resets_at: hoursFromNow(4) },
                        seven_day: { utilization: 50, resets_at: hoursFromNow(100) },
                    })
                ),
            ],
            { now: NOW }
        );

        expect(sortGrouped(scored)[1].accountName).toBe("cooling");
    });

    test("a stale invalid_grant account is expired even though usage data survives", () => {
        const [scored] = scoreAccounts(
            [
                {
                    accountName: "stale-dead",
                    usage: usage({ seven_day: { utilization: 10, resets_at: hoursFromNow(50) } }),
                    stale: {
                        lastSuccessAt: NOW.getTime() - 3_600_000,
                        reason: "Token expired (invalid_grant). Run: tools claude login stale-dead",
                    },
                },
            ],
            { now: NOW }
        );

        expect(scored.group).toBe("expired");
    });

    test("a stale account with a benign reason is not expired", () => {
        const [scored] = scoreAccounts(
            [
                {
                    accountName: "stale-429",
                    usage: usage({ seven_day: { utilization: 10, resets_at: hoursFromNow(50) } }),
                    stale: { lastSuccessAt: NOW.getTime() - 3_600_000, reason: "Usage API 429: rate limited" },
                },
            ],
            { now: NOW }
        );

        expect(scored.group).not.toBe("expired");
    });

    test("a 429 whose refresh failed is not expired, even when the text names invalid_grant", () => {
        const reason =
            "RetryableApiError: Usage API 429: rate limited (token refresh failed: Token expired (invalid_grant). Run: tools claude login side)";
        const [scored] = scoreAccounts(
            [
                {
                    accountName: "side",
                    usage: usage({ seven_day: { utilization: 10, resets_at: hoursFromNow(50) } }),
                    error: reason,
                    stale: { lastSuccessAt: NOW.getTime() - 60_000, reason },
                },
            ],
            { now: NOW }
        );

        expect(scored.group).not.toBe("expired");
        expect(scored.limits).toBeDefined();
    });

    test("scoreAccounts itself still returns tier order", () => {
        const ranked = scoreAccounts(
            [
                account("dead", usage({ seven_day: { utilization: 99, resets_at: hoursFromNow(20) } })),
                account("ready", usage({ seven_day: { utilization: 10, resets_at: hoursFromNow(20) } })),
            ],
            { now: NOW }
        );

        expect(ranked[0].accountName).toBe("ready");
    });
});

describe("scoreAccounts — org-blocked subscription", () => {
    const ORG_403 =
        'Usage API 403: {"type":"error","error":{"type":"permission_error",' +
        '"message":"OAuth authentication is currently not allowed for this organization."}}';

    test("stale replayed usage does not let an org-blocked account rank first", () => {
        const dead: AccountUsage = {
            accountName: "expired",
            usage: usage({ seven_day: { utilization: 36, resets_at: hoursFromNow(2) } }),
            stale: { lastSuccessAt: NOW.getTime() - 3_600_000, reason: ORG_403 },
        };
        const live = account("live", usage({ seven_day: { utilization: 50, resets_at: hoursFromNow(100) } }));

        const ranked = scoreAccounts([dead, live], { now: NOW });

        expect(ranked[0].accountName).toBe("live");
        expect(ranked[1].accountName).toBe("expired");
        expect(ranked[1].tier).toBe("no-data");
        expect(ranked[1].group).toBe("dead");
        expect(ranked[1].subscriptionExpired).toBe(true);
    });

    test("the sticky flag alone is enough, with no error string present", () => {
        const dead: AccountUsage = {
            accountName: "expired",
            orgBlocked: true,
            usage: usage({ seven_day: { utilization: 0, resets_at: null } }),
        };

        expect(scoreAccounts([dead], { now: NOW })[0].subscriptionExpired).toBe(true);
    });

    test("expired accounts stay in the result, they are never filtered out", () => {
        const dead: AccountUsage = { accountName: "expired", orgBlocked: true };
        const live = account("live", usage({}));

        const names = scoreAccounts([dead, live], { now: NOW })
            .map((s) => s.accountName)
            .sort();
        expect(names).toEqual(["expired", "live"]);
    });

    test("grouped order sinks an org-blocked account below every healthy one", () => {
        const dead: AccountUsage = {
            accountName: "expired",
            usage: usage({ seven_day: { utilization: 36, resets_at: hoursFromNow(2) } }),
            stale: { lastSuccessAt: NOW.getTime() - 3_600_000, reason: ORG_403 },
        };
        const live = account("live", usage({ seven_day: { utilization: 50, resets_at: hoursFromNow(100) } }));

        const grouped = sortGrouped(scoreAccounts([dead, live], { now: NOW }));
        expect(grouped[grouped.length - 1].accountName).toBe("expired");
    });
});

describe("fmtHours carry", () => {
    test("19.995h prints 20h, never 19h 60m", () => {
        const acc = account("a", usage({ seven_day: { utilization: 50, resets_at: hoursFromNow(19.995) } }));
        expect(scoreAccounts([acc], { now: NOW })[0].why).not.toContain("60m");
        expect(scoreAccounts([acc], { now: NOW })[0].why).toContain("20h");
    });
});

describe("scoreAccounts — plan gate", () => {
    test("a claude_free plan is unusable even with perfectly healthy buckets", () => {
        const free: AccountUsage = {
            accountName: "free-plan",
            subscriptionPlan: "claude_free",
            usage: usage({ seven_day: { utilization: 5, resets_at: hoursFromNow(100) } }),
        };
        const paid = account("paid", usage({ seven_day: { utilization: 50, resets_at: hoursFromNow(100) } }));

        const ranked = scoreAccounts([free, paid], { now: NOW });

        expect(ranked[0].accountName).toBe("paid");
        expect(ranked[1].subscriptionExpired).toBe(true);
        expect(ranked[1].why).toContain("claude_free");
    });

    test("a canceled subscription is unusable", () => {
        const canceled: AccountUsage = {
            accountName: "canceled",
            subscriptionStatus: "canceled",
            usage: usage({}),
        };

        expect(scoreAccounts([canceled], { now: NOW })[0].subscriptionExpired).toBe(true);
    });

    test("an unchecked plan never blocks — unknown is not dead", () => {
        const unknown = account("unknown", usage({ seven_day: { utilization: 10, resets_at: hoursFromNow(50) } }));

        expect(scoreAccounts([unknown], { now: NOW })[0].subscriptionExpired).toBeUndefined();
    });

    test("a paid plan scores normally", () => {
        const paid: AccountUsage = {
            accountName: "max",
            subscriptionPlan: "claude_max",
            subscriptionStatus: "active",
            usage: usage({ seven_day: { utilization: 10, resets_at: hoursFromNow(50) } }),
        };

        expect(scoreAccounts([paid], { now: NOW })[0].tier).toBe("ready");
    });
});

describe("an account without a 5-hour limit", () => {
    /** What a header reading of such an account holds: no 5h window, the weekly windows only. */
    const noFiveHour = (weeklyUsed: number, weeklyResetHours = 96): UsageResponse => ({
        five_hour: null,
        seven_day: { utilization: weeklyUsed, resets_at: hoursFromNow(weeklyResetHours) },
    });

    test("ranks by its weekly window alone: a spent 5h window elsewhere sinks, a roomier weekly elsewhere wins", () => {
        const absent = account("work", noFiveHour(50));
        // A real 5h window nearly spent: cooling, even with more weekly room.
        const cooling = account(
            "personal",
            usage({
                five_hour: { utilization: 99, resets_at: hoursFromNow(1) },
                seven_day: { utilization: 20, resets_at: hoursFromNow(96) },
            })
        );
        // A fresh 5h window and more weekly room: the weekly window decides, so it wins.
        const roomier = account("side", usage({ seven_day: { utilization: 10, resets_at: hoursFromNow(96) } }));

        const order = sortGrouped(scoreAccounts([cooling, absent, roomier], { now: NOW }));

        expect(order.map((scored) => scored.accountName)).toEqual(["side", "work", "personal"]);
        const work = order[1];
        expect(work).toMatchObject({
            tier: "ready",
            cooling: false,
            sessionHeadroomPct: 100,
            sessionUsableFraction: 1,
            absentLimits: [{ key: "five_hour", kind: "session" }],
        });
        expect(work.limits?.session).toBeUndefined();
        expect(work.why).toContain("no 5h limit");
        expect(work.why).not.toContain("5h 100% left");
    });

    test("on a tie it goes before an idle 5h window, which caps a burst once the first turn opens it", () => {
        const idle = account("personal", usage({ seven_day: { utilization: 50, resets_at: hoursFromNow(96) } }));
        const absent = account("work", noFiveHour(50));

        expect(scoreAccounts([idle, absent], { now: NOW }).map((scored) => scored.accountName)).toEqual([
            "work",
            "personal",
        ]);
        expect(sortGrouped(scoreAccounts([idle, absent], { now: NOW })).map((s) => s.accountName)).toEqual([
            "work",
            "personal",
        ]);
    });

    test("an old header reading's made-up 0 % session never shows as a 5h window", () => {
        const old = account(
            "work",
            usage({
                five_hour: { utilization: 0, resets_at: null },
                seven_day: { utilization: 50, resets_at: hoursFromNow(96) },
                limits: [
                    { kind: "session", percent: 0, severity: "normal", resets_at: null, scope: null, is_active: false },
                    {
                        kind: "weekly_all",
                        percent: 50,
                        severity: "normal",
                        resets_at: hoursFromNow(96),
                        scope: null,
                        is_active: true,
                    },
                ],
                quota: { source: "headers", fiveHourStatus: null, sevenDayStatus: "allowed" },
            })
        );
        const [scored] = scoreAccounts([old], { now: NOW });

        expect(scored.limits?.session).toBeUndefined();
        expect(scored.absentLimits).toEqual([{ key: "five_hour", kind: "session" }]);
    });
});
