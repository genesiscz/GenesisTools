import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { lastReadingChanges, UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { readLimitSeries } from "@genesiscz/utils/ai/usage-poll/series";
import { recordProbeRefusal, recordUsageEvent, useUsageEventsStoreForTests } from "./events/record";
import { countByKind, partialCountByKind, UsageEventsStore } from "./events/store";
import { limitsHealth } from "./poll-runs/health";
import { PollRunsStore, pollOutcomeOf } from "./poll-runs/store";

/**
 * The two stores of steps U5 and U6 against a migrated in-memory store, and the pure health answer. Every account
 * handle is invented.
 */

const T0 = new Date("2026-11-03T08:00:00.000Z");

function at(minutes: number): Date {
    return new Date(T0.getTime() + minutes * 60_000);
}

function snapshot(overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot {
    return {
        provider: "anthropic-sub",
        accountId: "acc_work",
        accountName: "work",
        fetchedAt: T0.toISOString(),
        limits: [],
        ...overrides,
    };
}

let limits: UsageLimitsDb;

beforeEach(() => {
    limits = new UsageLimitsDb(":memory:");
});

afterEach(() => {
    useUsageEventsStoreForTests(null);
    limits.close();
});

describe("usage events", () => {
    test("rows come back newest first, filtered by kind, provider and account id or name", () => {
        const store = new UsageEventsStore(limits.connection());
        store.insert({
            provider: "anthropic-sub",
            accountName: "work",
            source: "usage-client",
            kind: "usage-429",
            at: at(1),
        });
        store.insert({
            provider: "openai-sub",
            accountId: "acc_shop",
            accountName: "shop",
            source: "ai-proxy",
            kind: "cooldown",
            retryAfterMs: 120_000,
            at: at(2),
        });
        store.insert({
            provider: "anthropic-sub",
            accountName: "side",
            source: "poll-gate",
            kind: "poll-backoff",
            at: at(3),
        });

        const all = store.list({ from: T0, to: at(10) });

        expect(all.map((row) => row.kind)).toEqual(["poll-backoff", "cooldown", "usage-429"]);
        expect(store.list({ from: T0, to: at(10), kinds: ["cooldown"] })[0]).toMatchObject({
            accountId: "acc_shop",
            retryAfterMs: 120_000,
            day: null,
            count: 1,
        });
        expect(store.list({ from: T0, to: at(10), accounts: ["acc_shop"] }).map((row) => row.accountName)).toEqual([
            "shop",
        ]);
        expect(store.list({ from: T0, to: at(10), providers: ["anthropic-sub"] })).toHaveLength(2);
        expect(store.list({ from: at(5), to: at(10) })).toHaveLength(0);
    });

    test("a probe count is one row per account, model and hour, raised by each probe", () => {
        const store = new UsageEventsStore(limits.connection());

        for (const minute of [1, 2, 3]) {
            store.bumpHourly({
                provider: "anthropic-sub",
                accountName: "work",
                model: "haiku",
                source: "probe-budget",
                kind: "probe",
                day: "2026-11-03",
                at: at(minute),
            });
        }

        store.bumpHourly({
            provider: "anthropic-sub",
            accountName: "work",
            model: "fable",
            source: "probe-budget",
            kind: "probe",
            day: "2026-11-03",
            at: at(4),
        });

        const rows = store.list({ from: T0, to: at(10), kinds: ["probe"] });

        expect(rows.map((row) => [row.model, row.count, row.day])).toEqual([
            ["fable", 1, "2026-11-03"],
            ["haiku", 3, "2026-11-03"],
        ]);
        expect(countByKind(rows)).toEqual({ probe: 4 });
    });

    test("a count over part of a day counts only the probes inside it, before and after another bump", () => {
        const store = new UsageEventsStore(limits.connection());
        const probe = (minute: number, by = 1) =>
            store.bumpHourly({
                provider: "anthropic-sub",
                accountName: "work",
                model: "haiku",
                source: "probe-budget",
                kind: "probe",
                day: "2026-11-03",
                by,
                at: at(minute),
            });
        const counted = (from: Date, to: Date) => {
            const window = { from, to };
            return countByKind(store.list({ ...window, kinds: ["probe"] }), window);
        };

        // T0 is 08:00: ten probes at 08:00.
        probe(0, 10);

        expect(counted(at(60), at(180))).toEqual({});
        expect(counted(at(-60), at(60))).toEqual({ probe: 10 });

        probe(120);

        expect(counted(at(60), at(180))).toEqual({ probe: 1 });
        expect(counted(at(-60), at(60))).toEqual({ probe: 10 });
        expect(counted(at(-60), at(180))).toEqual({ probe: 11 });
    });

    test("a count row that crosses the window's edge is reported apart, never claimed whole", () => {
        const store = new UsageEventsStore(limits.connection());

        for (const minute of [10, 50]) {
            store.bumpHourly({
                provider: "anthropic-sub",
                accountName: "work",
                model: "haiku",
                source: "probe-budget",
                kind: "probe",
                day: "2026-11-03",
                at: at(minute),
            });
        }

        const window = { from: at(30), to: at(120) };
        const rows = store.list({ ...window, kinds: ["probe"] });

        expect(countByKind(rows, window)).toEqual({});
        expect(partialCountByKind(rows, window)).toEqual({ probe: 2 });
        expect(rows.map((row) => [row.firstTs, row.ts, row.count])).toEqual([
            [at(10).toISOString(), at(50).toISOString(), 2],
        ]);
    });

    test("refused probes are one row per account, model and hour, with a count and the latest refusal's detail", () => {
        const store = new UsageEventsStore(limits.connection());
        useUsageEventsStoreForTests(store);
        const refusal = { provider: "anthropic-sub", accountName: "work", model: "haiku", source: "probe-budget" };

        recordProbeRefusal({ ...refusal, detail: "the account probe budget of 7 days is spent", at: at(1) });
        recordProbeRefusal({ ...refusal, detail: "the account probe budget of 7 days is spent", at: at(2) });
        recordProbeRefusal({ ...refusal, detail: "the global probe budget of 7 days is spent", at: at(3) });
        recordProbeRefusal({ ...refusal, detail: "the global probe budget of 7 days is spent", at: at(24 * 60) });

        const rows = store.list({ from: T0, to: at(25 * 60), kinds: ["probe-refused"] });

        expect(rows.map((row) => [row.ts, row.count, row.detail, row.source])).toEqual([
            [at(24 * 60).toISOString(), 1, "the global probe budget of 7 days is spent", "probe-budget"],
            [at(3).toISOString(), 3, "the global probe budget of 7 days is spent", "probe-budget"],
        ]);
        expect(countByKind(rows)).toEqual({ "probe-refused": 4 });
    });

    test("recordUsageEvent never throws, even when its store is gone", () => {
        const broken = new Database(":memory:");
        useUsageEventsStoreForTests(new UsageEventsStore(broken));

        expect(() =>
            recordUsageEvent({ provider: "anthropic-sub", source: "usage-client", kind: "usage-429" })
        ).not.toThrow();
    });

    test("a store without the table lists nothing instead of failing", () => {
        expect(new UsageEventsStore(new Database(":memory:")).list({ from: T0, to: at(1) })).toEqual([]);
    });
});

describe("poll runs", () => {
    test("each snapshot maps to the most specific outcome", () => {
        expect(pollOutcomeOf(snapshot())).toBe("ok");
        expect(pollOutcomeOf(snapshot({ stale: { lastSuccessAt: T0.toISOString(), reason: "429" } }))).toBe("stale");
        expect(pollOutcomeOf(snapshot({ error: "boom" }))).toBe("error");
        expect(pollOutcomeOf(snapshot({ error: "403", auth: { orgBlocked: true } }))).toBe("blocked");
        expect(pollOutcomeOf(snapshot({ error: "held", blocked: { until: at(30).toISOString(), failures: 2 } }))).toBe(
            "backoff"
        );
        expect(pollOutcomeOf(snapshot({ error: "no token", needsLogin: { remedy: "tools claude login" } }))).toBe(
            "needs-login"
        );
    });

    test("one outcome is one run; a new outcome starts where the last one ended; a long gap is a hole", () => {
        const store = new PollRunsStore(limits.connection());
        const ok = { snapshot: snapshot(), source: "endpoint" };

        expect(store.recordRound([ok], at(0))).toEqual({ extended: 0, started: 1 });
        expect(store.recordRound([ok], at(1))).toEqual({ extended: 1, started: 0 });
        store.recordRound([{ snapshot: snapshot({ error: "boom" }), source: null }], at(2));
        // Thirty minutes with no round: the next run does not reach back over the hole.
        store.recordRound([ok], at(32));

        const runs = store.runsBetween({ from: T0, to: at(60) });

        expect(runs.map((run) => [run.outcome, run.from, run.to, run.polls])).toEqual([
            ["ok", at(0).toISOString(), at(1).toISOString(), 2],
            ["error", at(1).toISOString(), at(2).toISOString(), 1],
            ["ok", at(32).toISOString(), at(32).toISOString(), 1],
        ]);
        expect(store.lastRoundAt()).toBe(at(32).toISOString());
    });

    test("a different reading source starts a run of its own", () => {
        const store = new PollRunsStore(limits.connection());
        store.recordRound([{ snapshot: snapshot(), source: "endpoint" }], at(0));
        store.recordRound([{ snapshot: snapshot(), source: "headers" }], at(1));

        expect(store.runsBetween({ from: T0, to: at(5) }).map((run) => run.source)).toEqual(["endpoint", "headers"]);
    });
});

describe("limitsHealth", () => {
    test("coverage, gaps and the current outcome per account, with the daemon state", () => {
        const store = new PollRunsStore(limits.connection());

        for (let minute = 0; minute <= 10; minute++) {
            store.recordRound([{ snapshot: snapshot(), source: "endpoint" }], at(minute));
        }

        for (let minute = 40; minute <= 59; minute++) {
            store.recordRound(
                [
                    {
                        snapshot: snapshot({ error: "held", blocked: { until: at(90).toISOString(), failures: 1 } }),
                        source: null,
                    },
                ],
                at(minute)
            );
        }

        const { data, warnings } = limitsHealth({
            accounts: [
                { provider: "anthropic-sub", accountId: "acc_work", accountName: "work" },
                { provider: "openai-sub", accountId: "acc_shop", accountName: "shop" },
            ],
            runs: store.runsBetween({ from: T0, to: at(60) }),
            latest: store.latestRuns([{ provider: "anthropic-sub", accountId: "acc_work" }]),
            window: { from: T0, to: at(60) },
            now: at(60),
            heartbeatAgeMs: 30_000,
            lastRoundAt: store.lastRoundAt(),
            lastChanges: new Map(),
        });
        const [work, shop] = data.accounts;

        expect(warnings).toEqual([]);
        expect(data.daemon).toEqual({ heartbeatAgeMs: 30_000, alive: true, lastRoundAt: at(59).toISOString() });
        expect(work.outcome).toBe("backoff");
        expect(work.since).toBe(at(40).toISOString());
        expect(work.gateUntil).toBe(at(90).toISOString());
        // 0:00-0:11 and 0:40-1:00 are measured: 31 of 60 minutes.
        expect(work.coveragePct).toBe(51.7);
        expect(work.gaps).toEqual([{ from: at(11).toISOString(), to: at(40).toISOString(), minutes: 29 }]);
        expect(work.runs.map((run) => run.outcome)).toEqual(["ok", "backoff"]);
        expect(shop).toMatchObject({ outcome: "unmeasured", coveragePct: 0, lastPollAt: null });
        expect(shop.gaps).toEqual([{ from: T0.toISOString(), to: at(60).toISOString(), minutes: 60 }]);
    });

    test("an account polled fine with no usage change for half an hour is idle, one whose usage moved is active", () => {
        const store = new PollRunsStore(limits.connection());
        const reading = (account: string, minute: number, percent: number) =>
            limits.recordSnapshotV2(account, "five_hour", percent, at(minute).toISOString(), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "anthropic-sub",
                accountId: `acc_${account}`,
                kind: "session",
            });
        const accounts = [
            { provider: "anthropic-sub", accountId: "acc_work", accountName: "work" },
            { provider: "anthropic-sub", accountId: "acc_side", accountName: "side" },
            { provider: "anthropic-sub", accountId: "acc_shop", accountName: "shop" },
        ];

        for (let minute = 0; minute <= 59; minute++) {
            const entries = [
                { snapshot: snapshot(), source: "endpoint" },
                { snapshot: snapshot({ accountId: "acc_side", accountName: "side" }), source: "endpoint" },
            ];

            if (minute >= 45) {
                entries.push({
                    snapshot: snapshot({ accountId: "acc_shop", accountName: "shop" }),
                    source: "endpoint",
                });
            }

            store.recordRound(entries, at(minute));
        }

        // The store writes a reading only when it changed: work last moved at 0:05, side at 0:50, shop at 0:00.
        reading("work", 0, 10);
        reading("work", 5, 12);
        reading("side", 0, 10);
        reading("side", 50, 30);
        reading("shop", 0, 10);

        const { data } = limitsHealth({
            accounts,
            runs: store.runsBetween({ from: T0, to: at(60) }),
            latest: store.latestRuns(accounts),
            window: { from: T0, to: at(60) },
            now: at(60),
            heartbeatAgeMs: 30_000,
            lastRoundAt: store.lastRoundAt(),
            lastChanges: lastReadingChanges(limits.connection(), accounts),
        });

        expect(data.accounts.map((account) => [account.accountName, account.activity, account.lastChangeAt])).toEqual([
            ["work", "idle", at(5).toISOString()],
            ["side", "active", at(50).toISOString()],
            // Polled for 15 minutes only: too short to call a quiet account idle.
            ["shop", null, at(0).toISOString()],
        ]);
    });

    test("a past window reads coverage from the window and the current state from the newest run", () => {
        const store = new PollRunsStore(limits.connection());
        const work = { provider: "anthropic-sub", accountId: "acc_work", accountName: "work" };

        for (let minute = 0; minute <= 10; minute++) {
            store.recordRound([{ snapshot: snapshot(), source: "endpoint" }], at(minute));
        }

        const held = snapshot({ error: "held", blocked: { until: at(90).toISOString(), failures: 1 } });

        for (let minute = 40; minute <= 59; minute++) {
            store.recordRound([{ snapshot: held, source: null }], at(minute));
        }

        // The window ends before the account went into backoff: coverage is the window's, NOW is the newest run's.
        const pastWindow = { from: T0, to: at(5) };
        const { data } = limitsHealth({
            accounts: [work],
            runs: store.runsBetween({ ...pastWindow, accounts: [work] }),
            latest: store.latestRuns([work]),
            window: pastWindow,
            now: at(60),
            heartbeatAgeMs: 30_000,
            lastRoundAt: store.lastRoundAt(),
            lastChanges: new Map(),
        });

        expect(data.accounts[0]).toMatchObject({
            outcome: "backoff",
            lastPollAt: at(59).toISOString(),
            gateUntil: at(90).toISOString(),
            coveragePct: 100,
        });
        expect(data.accounts[0].runs.map((run) => run.outcome)).toEqual(["ok"]);
        expect(store.runsBetween({ from: T0, to: at(60), accounts: [] })).toEqual([]);
        expect(
            store.runsBetween({ from: T0, to: at(60), accounts: [{ provider: "openai-sub", accountId: "acc_work" }] })
        ).toEqual([]);
    });

    test("a daemon that never ran and an empty store are warnings, never an empty success", () => {
        const { warnings } = limitsHealth({
            accounts: [],
            runs: [],
            latest: [],
            window: { from: T0, to: at(60) },
            now: at(60),
            heartbeatAgeMs: null,
            lastRoundAt: null,
            lastChanges: new Map(),
        });

        expect(warnings.map((warning) => warning.code)).toEqual(["daemon-down", "no-runs"]);
    });
});

describe("the series door", () => {
    test("returns the coverage runs and the events of the accounts its series name, and no one else's", () => {
        limits.recordSnapshotV2("work", "five_hour", 40, at(1).toISOString(), {
            resetsAt: null,
            severity: null,
            scopeModel: null,
            provider: "anthropic-sub",
            accountId: "acc_work",
            kind: "session",
        });
        new PollRunsStore(limits.connection()).recordRound(
            [
                { snapshot: snapshot(), source: "endpoint" },
                { snapshot: snapshot({ accountId: "acc_side", accountName: "side" }), source: "endpoint" },
            ],
            at(1)
        );
        const events = new UsageEventsStore(limits.connection());
        events.insert({
            provider: "anthropic-sub",
            accountName: "work",
            source: "usage-client",
            kind: "usage-429",
            at: at(2),
        });
        events.insert({
            provider: "anthropic-sub",
            accountName: "side",
            source: "usage-client",
            kind: "usage-429",
            at: at(2),
        });

        const data = readLimitSeries(
            { from: T0.toISOString(), to: at(10).toISOString(), agg: "raw" },
            {
                db: limits,
                directory: [{ provider: "anthropic-sub", accountId: "acc_work", accountName: "work" }],
                current: [],
            }
        );

        expect(data.series).toHaveLength(1);
        expect(data.coverage).toEqual([
            {
                provider: "anthropic-sub",
                accountId: "acc_work",
                accountName: "work",
                runs: [
                    { from: at(1).toISOString(), to: at(1).toISOString(), outcome: "ok", source: "endpoint", polls: 1 },
                ],
            },
        ]);
        expect(data.events.map((event) => event.accountName)).toEqual(["work"]);
    });

    test("an account removed from config keeps its stored id, so its coverage runs still join", () => {
        for (const [minute, accountId] of [
            [1, null],
            [2, "acc_side"],
        ] as const) {
            limits.recordSnapshotV2("side", "five_hour", 40 + minute, at(minute).toISOString(), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "anthropic-sub",
                accountId,
                kind: "session",
            });
        }

        new PollRunsStore(limits.connection()).recordRound(
            [{ snapshot: snapshot({ accountId: "acc_side", accountName: "side" }), source: "endpoint" }],
            at(2)
        );

        const data = readLimitSeries(
            { from: T0.toISOString(), to: at(10).toISOString(), agg: "raw" },
            { db: limits, directory: [], current: [] }
        );

        expect(data.series.map((item) => [item.accountName, item.accountId])).toEqual([["side", "acc_side"]]);
        expect(data.coverage).toEqual([
            {
                provider: "anthropic-sub",
                accountId: "acc_side",
                accountName: "side",
                runs: [
                    { from: at(2).toISOString(), to: at(2).toISOString(), outcome: "ok", source: "endpoint", polls: 1 },
                ],
            },
        ]);
    });
});
