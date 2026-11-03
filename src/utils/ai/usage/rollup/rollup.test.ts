import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import type { SeriesEntry } from "@genesiscz/utils/ai/usage-poll/series-rows";
import type { AttributedEvent } from "../attribution/spend-share";
import { type DailyRow, dailyRowsOf, rollUpRecentDays, UsageDailyStore } from "./daily";
import { digestSpend, digestWindows } from "./digest";

/** The daily rollup and the digest folds over invented accounts; days are drawn in UTC so the test has no zone. */

const TZ = "UTC";
let limits: UsageLimitsDb;

beforeEach(() => {
    limits = new UsageLimitsDb(":memory:");
});

afterEach(() => {
    limits.close();
});

function entry(points: Array<[string, number]>, overrides: Partial<SeriesEntry> = {}): SeriesEntry {
    return {
        provider: "anthropic-sub",
        account: "work",
        key: "five_hour",
        kind: "session",
        scopeModel: null,
        resets: [],
        availability: [],
        points: points.map(([t, percent]) => ({ t, percent, resetsAt: null, severity: null })),
        ...overrides,
    };
}

describe("dailyRowsOf", () => {
    test("a day the window was gone all day gets a row, and a window gone after its last reading ends the day absent", () => {
        const rows = dailyRowsOf({
            series: [
                entry([["2026-11-01T08:00:00Z", 30]], {
                    availability: [
                        { from: "2026-11-01T08:00:00Z", to: "2026-11-01T20:00:00Z", state: "limited" },
                        { from: "2026-11-01T20:00:00Z", to: "2026-11-03T12:00:00Z", state: "absent" },
                    ],
                }),
            ],
            tz: TZ,
            runs: [],
            accountIdOf: () => "acc-work",
        });

        expect(rows.map((row) => [row.day, row.readings, row.endPct, row.availability])).toEqual([
            ["2026-11-01", 1, 30, "absent"],
            ["2026-11-02", 0, 0, "absent"],
            ["2026-11-03", 0, 0, "absent"],
        ]);
    });

    test("one row per day with its first, last and peak reading, its resets, and the cycles that reached 90%", () => {
        const rows = dailyRowsOf({
            series: [
                entry(
                    [
                        ["2026-11-01T08:00:00Z", 10],
                        ["2026-11-01T10:00:00Z", 95],
                        ["2026-11-01T13:00:00Z", 3],
                        ["2026-11-01T15:00:00Z", 40],
                        ["2026-11-02T09:00:00Z", 91],
                    ],
                    { resets: ["2026-11-01T13:00:00Z"] }
                ),
            ],
            tz: TZ,
            runs: [
                {
                    id: 1,
                    provider: "anthropic-sub",
                    accountId: "acc-work",
                    accountName: "work",
                    from: "2026-11-01T22:00:00Z",
                    to: "2026-11-02T01:00:00Z",
                    outcome: "ok",
                    source: null,
                    gateUntil: null,
                    reason: null,
                    polls: 180,
                },
            ],
            accountIdOf: () => "acc-work",
        });

        expect(
            rows.map((row) => [
                row.day,
                row.startPct,
                row.endPct,
                row.peakPct,
                row.resets,
                row.cyclesOver90,
                row.minutesMeasured,
            ])
        ).toEqual([
            ["2026-11-01", 10, 40, 95, 1, 1, 120],
            ["2026-11-02", 91, 91, 91, 0, 1, 60],
        ]);
    });

    test("the store keeps one row per account, window and day; a second write of a day replaces it", () => {
        const store = new UsageDailyStore(limits.connection());
        const row: DailyRow = {
            provider: "anthropic-sub",
            accountId: "acc-work",
            accountName: "work",
            bucket: "seven_day",
            kind: "weekly",
            day: "2026-11-01",
            tz: TZ,
            startPct: 10,
            endPct: 20,
            peakPct: 20,
            resets: 0,
            cyclesOver90: 0,
            readings: 4,
            minutesMeasured: null,
            availability: "limited",
        };

        store.upsert([row], new Date("2026-11-01T10:00:00Z"));
        store.upsert([{ ...row, endPct: 30, peakPct: 30 }], new Date("2026-11-01T11:00:00Z"));

        expect(store.between({ from: "2026-11-01", to: "2026-11-01" }).map((r) => r.endPct)).toEqual([30]);
        expect(store.lastUpdatedAt()).toBe("2026-11-01T11:00:00.000Z");
    });

    test("the daemon's rollup writes yesterday and today once, then waits out its interval", () => {
        limits.recordSnapshotV2("work", "seven_day", 12, "2026-11-02T08:00:00.000Z", {
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: "anthropic-sub",
            accountId: "acc-work",
            kind: "weekly",
        });
        const now = new Date("2026-11-02T12:00:00Z");
        const run = (at: Date) => rollUpRecentDays({ db: limits, now: at, tz: TZ, accountIdOf: () => "acc-work" });

        expect(run(now)).toBe(1);
        expect(run(new Date(now.getTime() + 60_000))).toBe(0);
    });
});

describe("digest folds", () => {
    test("a window absent for the rest of the period reads 'no limit since' its first absent day", () => {
        const base = {
            provider: "anthropic-sub",
            accountId: "acc-work",
            accountName: "work",
            bucket: "five_hour",
            kind: "session",
            tz: TZ,
        };
        const day = (d: string, availability: DailyRow["availability"]): DailyRow => ({
            ...base,
            day: d,
            startPct: 0,
            endPct: 0,
            peakPct: 0,
            resets: 0,
            cyclesOver90: 0,
            readings: 1,
            minutesMeasured: 60,
            availability,
        });
        const [window] = digestWindows(
            [day("2026-11-01", "limited"), day("2026-11-02", "absent"), day("2026-11-03", "absent")],
            () => ({
                provider: "anthropic-sub",
                accountId: "acc-work",
                accountName: "work",
            })
        );

        expect(window?.noLimitSince).toBe("2026-11-02");
        expect(window?.minutesMeasured).toBe(180);
    });

    test("spend groups by provider and model and keeps the five costliest sessions", () => {
        const event = (session: string, usd: number, model: string): AttributedEvent => ({
            at: 0,
            costUsd: usd,
            tokens: 0,
            unpriced: false,
            model,
            provider: "anthropic-sub",
            agent: "claude",
            file: "/fixture/s.jsonl",
            owner: { sessionId: session, leadSessionId: session, subagent: false, project: "-repo" },
            account: { basis: "none", approximate: false },
        });
        const spend = digestSpend(
            [event("a", 3, "m-big"), event("b", 1, "m-small"), event("a", 2, "m-small")],
            (id) => `report ${id}`
        );

        expect(spend.byModel).toEqual([
            { model: "m-big", usd: 3 },
            { model: "m-small", usd: 3 },
        ]);
        expect(spend.topSessions.map((s) => [s.sessionId, s.costUsd, s.next])).toEqual([
            ["a", 5, "report a"],
            ["b", 1, "report b"],
        ]);
    });
});
