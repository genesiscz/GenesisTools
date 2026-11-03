import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { USAGE_LIMITS_MIGRATIONS } from "@genesiscz/utils/ai/usage-poll/migrations";
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

    test("a limited window with no new reading is carried through each day the poller measured it", () => {
        const measured = (from: string, to: string) => ({
            id: 1,
            provider: "anthropic-sub",
            accountId: "acc-work",
            accountName: "work",
            from,
            to,
            outcome: "ok" as const,
            source: null,
            gateUntil: null,
            reason: null,
            polls: 100,
        });
        const rows = dailyRowsOf({
            series: [
                entry([["2026-11-01T08:00:00Z", 40]], {
                    availability: [{ from: "2026-11-01T08:00:00Z", to: "2026-11-04T12:00:00Z", state: "limited" }],
                }),
                // Only the state carried into the range: no reading in it at all.
                entry([], {
                    key: "seven_day",
                    kind: "weekly",
                    carried: { t: "2026-10-30T08:00:00Z", percent: 55, resetsAt: null, severity: null },
                    availability: [{ from: "2026-11-01T00:00:00Z", to: "2026-11-04T12:00:00Z", state: "limited" }],
                }),
            ],
            tz: TZ,
            // The poller measured the account through 11-03 and was off on 11-04.
            runs: [measured("2026-11-01T00:00:00Z", "2026-11-03T23:00:00Z")],
            accountIdOf: () => "acc-work",
        });

        expect(
            rows.map((row) => [
                row.bucket,
                row.day,
                row.readings,
                row.startPct,
                row.endPct,
                row.peakPct,
                row.availability,
            ])
        ).toEqual([
            ["five_hour", "2026-11-01", 1, 40, 40, 40, "limited"],
            ["five_hour", "2026-11-02", 0, 40, 40, 40, "limited"],
            ["five_hour", "2026-11-03", 0, 40, 40, 40, "limited"],
            ["seven_day", "2026-11-01", 0, 55, 55, 55, "limited"],
            ["seven_day", "2026-11-02", 0, 55, 55, 55, "limited"],
            ["seven_day", "2026-11-03", 0, 55, 55, 55, "limited"],
        ]);
    });

    test("the daemon's rollup carries a quiet limited window into the days after its last reading", () => {
        limits.recordSnapshotV2("work", "seven_day", 40, "2026-10-30T08:00:00.000Z", {
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: "anthropic-sub",
            accountId: "acc-work",
            kind: "weekly",
        });
        limits
            .connection()
            .prepare(
                `INSERT INTO usage_poll_runs (provider, account_id, account_name, from_ts, to_ts, outcome, polls)
                 VALUES ('anthropic-sub', 'acc-work', 'work', '2026-10-30T00:00:00.000Z', '2026-11-02T12:00:00.000Z', 'ok', 500)`
            )
            .run();
        const store = new UsageDailyStore(limits.connection());
        const run = (at: string) =>
            rollUpRecentDays({ db: limits, now: new Date(at), tz: TZ, accountIdOf: () => "acc-work", force: true });

        run("2026-10-31T12:00:00Z");
        // The next pass starts at 10-31, after the only reading: the window is carried in, not dropped.
        run("2026-11-02T12:00:00Z");

        expect(
            store.between({ from: "2026-10-01", to: "2026-11-30" }).map((r) => [r.day, r.readings, r.endPct])
        ).toEqual([
            ["2026-10-30", 1, 40],
            ["2026-10-31", 0, 40],
            ["2026-11-01", 0, 40],
            ["2026-11-02", 0, 40],
        ]);
    });

    test("a cycle over 90% that crosses midnight counts once, on the day it first reached 90%", () => {
        const point = (t: string, percent: number, resetsAt: string) => ({ t, percent, resetsAt, severity: null });
        const rows = dailyRowsOf({
            series: [
                {
                    ...entry([]),
                    resets: ["2026-11-02T03:00:00Z"],
                    points: [
                        point("2026-11-01T22:00:00Z", 92, "2026-11-02T03:00:00Z"),
                        point("2026-11-02T01:00:00Z", 96, "2026-11-02T03:00:00Z"),
                        point("2026-11-02T05:00:00Z", 10, "2026-11-02T08:00:00Z"),
                        point("2026-11-02T07:00:00Z", 93, "2026-11-02T08:00:00Z"),
                    ],
                },
                // The cycle carried into the range already reached 90% on an earlier day.
                {
                    ...entry([], { key: "five_hour_b" }),
                    carried: point("2026-11-03T00:00:00Z", 95, "2026-11-03T05:00:00Z"),
                    points: [point("2026-11-03T01:00:00Z", 97, "2026-11-03T05:00:00Z")],
                },
            ],
            tz: TZ,
            runs: [],
            accountIdOf: () => "acc-work",
        });

        expect(rows.map((row) => [row.bucket, row.day, row.cyclesOver90])).toEqual([
            ["five_hour", "2026-11-01", 1],
            ["five_hour", "2026-11-02", 1],
            ["five_hour_b", "2026-11-03", 0],
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

    test("a slot that changed kind within a day keeps one row per kind, and a kind-less row is still one row", () => {
        const store = new UsageDailyStore(limits.connection());
        const row: DailyRow = {
            provider: "openai-sub",
            accountId: "acc-work",
            accountName: "work",
            bucket: "primary",
            kind: "session",
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

        store.upsert([row, { ...row, kind: "weekly", endPct: 5, peakPct: 5 }], new Date("2026-11-01T10:00:00Z"));
        store.upsert([{ ...row, kind: null }], new Date("2026-11-01T10:00:00Z"));
        store.upsert([{ ...row, kind: null, endPct: 7 }], new Date("2026-11-01T11:00:00Z"));

        const day = store.between({ from: "2026-11-01", to: "2026-11-01" });
        expect(day.map((r) => [r.kind, r.endPct]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
            [null, 7],
            ["session", 20],
            ["weekly", 5],
        ]);
    });

    test("the kind migration rebuilds an old usage_daily with every row kept", () => {
        const db = new Database(":memory:");
        const byId = (id: string) => {
            const migration = USAGE_LIMITS_MIGRATIONS.find((m) => m.id === id);

            if (!migration) {
                throw new Error(`no migration ${id}`);
            }

            return migration;
        };
        const ctx = { tableName: "usage_limits" };
        byId("2026-11-usage-daily").apply(db, ctx);
        const insert = db.prepare(
            `INSERT INTO usage_daily (provider, account_id, account_name, bucket, kind, day, tz, start_pct, end_pct,
                peak_pct, resets, cycles_over_90, readings, minutes_measured, availability, updated_at)
             VALUES (?, 'acc-work', 'work', ?, ?, '2026-11-01', 'UTC', 1, 2, 3, 0, 0, 1, NULL, 'limited', 'x')`
        );
        insert.run("anthropic-sub", "five_hour", "session");
        insert.run("anthropic-sub", "legacy", null);
        const migration = byId("2026-11-usage-daily-kind");

        expect(migration.isApplied?.(db, ctx)).toBe(false);
        migration.apply(db, ctx);
        expect(migration.isApplied?.(db, ctx)).toBe(true);

        const rows = new UsageDailyStore(db).between({ from: "2026-11-01", to: "2026-11-01" });
        expect(rows.map((r) => [r.bucket, r.kind])).toEqual([
            ["five_hour", "session"],
            ["legacy", null],
        ]);
        db.close();
    });

    test("the first rollup backfills every retained day, and a later one resumes from the last day it wrote", () => {
        const reading = { resetsAt: null, severity: null, scopeModel: null, provider: "anthropic-sub", kind: "weekly" };
        limits.recordSnapshotV2("work", "seven_day", 10, "2026-10-28T08:00:00.000Z", reading);
        limits.recordSnapshotV2("work", "seven_day", 20, "2026-10-30T08:00:00.000Z", reading);
        limits.recordSnapshotV2("work", "seven_day", 30, "2026-11-02T08:00:00.000Z", reading);
        const store = new UsageDailyStore(limits.connection());

        rollUpRecentDays({ db: limits, now: new Date("2026-11-02T12:00:00Z"), tz: TZ, accountIdOf: () => "acc-work" });

        expect(store.between({ from: "2026-10-01", to: "2026-11-30" }).map((r) => [r.day, r.peakPct])).toEqual([
            ["2026-10-28", 10],
            ["2026-10-30", 20],
            ["2026-11-02", 30],
        ]);
        expect(store.lastDay(TZ)).toBe("2026-11-02");

        // The daemon was down for three days: the next pass starts at 11-02, not at yesterday.
        limits.recordSnapshotV2("work", "seven_day", 40, "2026-11-03T08:00:00.000Z", reading);
        rollUpRecentDays({ db: limits, now: new Date("2026-11-06T12:00:00Z"), tz: TZ, accountIdOf: () => "acc-work" });

        expect(store.between({ from: "2026-11-03", to: "2026-11-03" }).map((r) => r.peakPct)).toEqual([40]);
    });

    test("a renamed account keeps its daily rows under the new name", () => {
        limits.recordSnapshotV2("work", "seven_day", 12, "2026-11-02T08:00:00.000Z", {
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: "anthropic-sub",
            kind: "weekly",
        });
        const store = new UsageDailyStore(limits.connection());
        rollUpRecentDays({ db: limits, now: new Date("2026-11-02T12:00:00Z"), tz: TZ, accountIdOf: () => "acc-work" });

        limits.renameAccount("work", "office");

        expect(store.between({ from: "2026-11-02", to: "2026-11-02" }).map((r) => r.accountName)).toEqual(["office"]);
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
    test("a period that starts or ends on a day with no reading takes its start and end from the read days", () => {
        const day = (d: string, readings: number, start: number, end: number): DailyRow => ({
            provider: "anthropic-sub",
            accountId: "acc-work",
            accountName: "work",
            bucket: "five_hour",
            kind: "session",
            tz: TZ,
            day: d,
            startPct: start,
            endPct: end,
            peakPct: end,
            resets: 0,
            cyclesOver90: 0,
            readings,
            minutesMeasured: 60,
            availability: readings > 0 ? "limited" : "absent",
        });
        const [window] = digestWindows(
            [day("2026-11-01", 0, 0, 0), day("2026-11-02", 3, 50, 70), day("2026-11-03", 0, 0, 0)],
            () => ({ provider: "anthropic-sub", accountId: "acc-work", accountName: "work" })
        );

        expect([window?.startPct, window?.endPct]).toEqual([50, 70]);
    });

    test("one slot that held two kinds folds into one window per kind", () => {
        const row = (kind: string, peakPct: number): DailyRow => ({
            provider: "openai-sub",
            accountId: "acc-work",
            accountName: "work",
            bucket: "primary",
            kind,
            tz: TZ,
            day: "2026-11-01",
            startPct: 0,
            endPct: peakPct,
            peakPct,
            resets: 0,
            cyclesOver90: 0,
            readings: 2,
            minutesMeasured: 60,
            availability: "limited",
        });
        const windows = digestWindows([row("session", 80), row("weekly", 12)], () => ({
            provider: "openai-sub",
            accountId: "acc-work",
            accountName: "work",
        }));

        expect(windows.map((w) => [w.kind, w.peakPct])).toEqual([
            ["session", 80],
            ["weekly", 12],
        ]);
    });

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
