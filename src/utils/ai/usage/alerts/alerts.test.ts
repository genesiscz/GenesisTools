import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { windowPace } from "@genesiscz/utils/ai/usage/budgets/budgets";
import { UsageEventsStore } from "@genesiscz/utils/ai/usage/events/store";
import type { UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import { PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { SafeJSON } from "@genesiscz/utils/json";
import { ALERT_RULE_DEFAULTS, inQuietHours, mergeAlertsConfig, type UsageAlertsConfig } from "./config";
import { judgeRound, runAlertEngine } from "./engine";
import { seedThresholdAlerts } from "./legacy-seed";
import { UsageAlertsStore } from "./log";
import { buildAlertRound } from "./round";
import { ALERT_RULES } from "./rules";
import type { AlertChannel, AlertChannelTable, AlertRound, StoredAlert } from "./types";

/**
 * The alert engine of step U7 against a migrated in-memory store: each rule's verdict, the engine's dedupe and
 * delivery, and the one-time seed from the old notifier. Every account handle is invented; the clock is a parameter.
 */

const NOW = new Date("2026-11-03T10:00:00.000Z");
const RESET = "2026-11-03T13:00:00.000Z";

function minutes(n: number): Date {
    return new Date(NOW.getTime() + n * 60_000);
}

function snapshot(percent: number, overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot {
    return {
        provider: "anthropic-sub",
        accountId: "acc_work",
        accountName: "work",
        fetchedAt: NOW.toISOString(),
        limits: [{ key: "five_hour", label: "5h", kind: "session", percentUsed: percent, resetsAt: RESET }],
        ...overrides,
    };
}

function round(overrides: Partial<AlertRound> = {}): AlertRound {
    return {
        now: NOW,
        snapshots: [],
        samples: [],
        runs: [],
        previousRoundAt: null,
        events: [],
        availabilityChanges: [],
        budgets: { global: {}, providers: {} },
        ...overrides,
    };
}

interface RecordingChannel extends AlertChannel {
    delivered: StoredAlert[];
}

function recording(id: AlertChannel["id"], interrupts: boolean, fail = false): RecordingChannel {
    const delivered: StoredAlert[] = [];

    return {
        id,
        interrupts,
        delivered,
        async deliver(alert) {
            delivered.push(alert);

            if (fail) {
                throw new Error("channel down");
            }
        },
    };
}

let limits: UsageLimitsDb;
let store: UsageAlertsStore;
let macos: RecordingChannel;
let inbox: RecordingChannel;
let channels: AlertChannelTable;

beforeEach(() => {
    limits = new UsageLimitsDb(":memory:");
    store = new UsageAlertsStore(limits.connection());
    macos = recording("macos", true);
    inbox = recording("inbox", false);
    channels = { macos, inbox };
});

afterEach(() => {
    limits.close();
});

function config(overrides: Parameters<typeof mergeAlertsConfig>[0] = {}): UsageAlertsConfig {
    return mergeAlertsConfig(overrides);
}

describe("threshold rule through the engine", () => {
    test("fires the highest crossed threshold once per cycle, again for a higher one, and again after a reset", async () => {
        const first = await runAlertEngine({
            round: round({ snapshots: [snapshot(85)] }),
            config: config(),
            store,
            channels,
        });

        expect(first.map((alert) => [alert.rule, alert.severity, alert.level, alert.message])).toEqual([
            ["threshold", 80, "critical", "work: 5h 85%"],
        ]);
        expect(macos.delivered).toHaveLength(1);
        expect(inbox.delivered).toHaveLength(0);

        const repeat = await runAlertEngine({
            round: round({ now: minutes(1), snapshots: [snapshot(88)] }),
            config: config(),
            store,
            channels,
        });
        expect(repeat).toEqual([]);

        // The provider moved the reset by two minutes: the same cycle, still nothing.
        const jitter = snapshot(89, {
            limits: [
                {
                    key: "five_hour",
                    label: "5h",
                    kind: "session",
                    percentUsed: 89,
                    resetsAt: "2026-11-03T13:02:00.000Z",
                },
            ],
        });
        expect(
            await runAlertEngine({
                round: round({ now: minutes(2), snapshots: [jitter] }),
                config: config(),
                store,
                channels,
            })
        ).toEqual([]);

        const nextCycle = snapshot(81, {
            limits: [
                {
                    key: "five_hour",
                    label: "5h",
                    kind: "session",
                    percentUsed: 81,
                    resetsAt: "2026-11-03T18:00:00.000Z",
                },
            ],
        });
        const after = await runAlertEngine({
            round: round({ now: minutes(200), snapshots: [nextCycle] }),
            config: config(),
            store,
            channels,
        });
        expect(after).toHaveLength(1);
    });

    test("a weekly window uses the weekly list and re-fires as it climbs it", async () => {
        const weekly = (percent: number) =>
            snapshot(percent, {
                limits: [{ key: "seven_day", label: "7d", kind: "weekly", percentUsed: percent, resetsAt: RESET }],
            });

        await runAlertEngine({ round: round({ snapshots: [weekly(25)] }), config: config(), store, channels });
        await runAlertEngine({
            round: round({ now: minutes(1), snapshots: [weekly(45)] }),
            config: config(),
            store,
            channels,
        });

        expect(macos.delivered.map((alert) => alert.severity)).toEqual([20, 40]);
    });

    test("stale and failed rows never alert", async () => {
        const stale = snapshot(95, { stale: { lastSuccessAt: NOW.toISOString(), reason: "429" } });
        const failed = snapshot(95, { error: "boom" });

        expect(
            await runAlertEngine({ round: round({ snapshots: [stale, failed] }), config: config(), store, channels })
        ).toEqual([]);
    });
});

describe("the engine", () => {
    test("records before delivering, so a failing channel never makes the next tick fire again", async () => {
        const failing = recording("macos", true, true);
        const table = { macos: failing, inbox };

        expect(
            await runAlertEngine({
                round: round({ snapshots: [snapshot(85)] }),
                config: config(),
                store,
                channels: table,
            })
        ).toHaveLength(1);
        expect(
            await runAlertEngine({
                round: round({ now: minutes(1), snapshots: [snapshot(85)] }),
                config: config(),
                store,
                channels: table,
            })
        ).toEqual([]);
        expect(store.list({ from: minutes(-1), to: minutes(5) })[0].channels).toEqual(["macos"]);
    });

    test("quiet hours hold the banner and keep the record", async () => {
        const quiet = config({ global: { quietHours: { start: "00:00", end: "23:59" } } });
        const fired = await runAlertEngine({
            round: round({ snapshots: [snapshot(85)] }),
            config: quiet,
            store,
            channels,
        });

        expect(fired[0].channels).toEqual([]);
        expect(macos.delivered).toEqual([]);
    });

    test("a provider can turn one rule off; the rule still runs for the others", async () => {
        const off = config({ providers: { "anthropic-sub": { rules: { threshold: { enabled: false } } } } });
        const shop = snapshot(90, { provider: "openai-sub", accountId: "acc_shop", accountName: "shop" });
        const fired = await runAlertEngine({
            round: round({ snapshots: [snapshot(90), shop] }),
            config: off,
            store,
            channels,
        });

        expect(fired.map((alert) => alert.accountName)).toEqual(["shop"]);
    });

    test("a key another process recorded after this round was judged is not fired or delivered again", async () => {
        // The other process (the usage TUI, say) records the alert between this round's judging and its insert.
        class LateStore extends UsageAlertsStore {
            override latestByDedupe(): StoredAlert | null {
                return null;
            }
        }

        const late = new LateStore(limits.connection());
        await runAlertEngine({ round: round({ snapshots: [snapshot(85)] }), config: config(), store, channels });
        macos.delivered.length = 0;

        const fired = await runAlertEngine({
            round: round({ now: minutes(1), snapshots: [snapshot(85)] }),
            config: config(),
            store: late,
            channels,
        });

        expect(fired).toEqual([]);
        expect(macos.delivered).toEqual([]);
        expect(store.list({ from: minutes(-1), to: minutes(5) })).toHaveLength(1);
    });

    test("judgeRound answers what would fire and writes nothing", () => {
        const judged = judgeRound({ round: round({ snapshots: [snapshot(85)] }), config: config(), store });

        expect(judged.map((entry) => entry.fires)).toEqual([true]);
        expect(store.list({ from: minutes(-60), to: minutes(60) })).toEqual([]);
    });

    test("acknowledging marks the open alerts once", async () => {
        await runAlertEngine({ round: round({ snapshots: [snapshot(85)] }), config: config(), store, channels });

        expect(store.ack({ at: minutes(1) })).toBe(1);
        expect(store.ack({ at: minutes(2) })).toBe(0);
        expect(store.list({ from: minutes(-1), to: minutes(5), unackedOnly: true })).toEqual([]);
    });
});

describe("predicted-exhaust rule", () => {
    /** A 5-hour window rising 2 % every 5 minutes for the last hour, ending at `end` %. */
    function rising(end: number): UsageSample[] {
        return Array.from({ length: 13 }, (_, i) => ({
            provider: "anthropic-sub",
            account: "work",
            bucket: "five_hour",
            kind: "session",
            utilization: end - (12 - i) * 2,
            resetsAt: RESET,
            timestamp: minutes(-60 + i * 5).toISOString(),
        }));
    }

    test("fires when the window runs out before its reset within the session lead time", () => {
        const candidates = ALERT_RULES["predicted-exhaust"].evaluate(
            round({ snapshots: [snapshot(86)], samples: rising(86) }),
            ALERT_RULE_DEFAULTS["predicted-exhaust"]
        );

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({ windowKey: "five_hour", accountId: "acc_work", cycle: RESET });
        expect(candidates[0].message).toStartWith("work: 5h 86%, at limit ");
        expect(candidates[0].message).toEndWith("(24%/h, active pace).");
    });

    test("an idle window is skipped while requireActive is on", () => {
        const idle = rising(86).map((sample) => ({
            ...sample,
            timestamp: new Date(Date.parse(sample.timestamp) - 40 * 60_000).toISOString(),
        }));
        const settings = ALERT_RULE_DEFAULTS["predicted-exhaust"];

        expect(
            ALERT_RULES["predicted-exhaust"].evaluate(round({ snapshots: [snapshot(86)], samples: idle }), settings)
        ).toEqual([]);
    });

    test("in one cycle it re-fires only when the run-out moved at least 30 minutes earlier", () => {
        const rule = ALERT_RULES["predicted-exhaust"];
        const previous = store.insert(
            {
                rule: "predicted-exhaust",
                provider: "anthropic-sub",
                accountId: "acc_work",
                accountName: "work",
                windowKind: "session",
                windowKey: "five_hour",
                dedupeKey: "k",
                cycle: RESET,
                severity: 80,
                level: "warning",
                title: "t",
                message: "m",
                payload: { exhaustAt: "2026-11-03T10:40:00.000Z" },
            },
            { firedAt: NOW, channels: [] }
        );
        const later = { ...previous, payload: { exhaustAt: "2026-11-03T10:20:00.000Z" } };
        const muchEarlier = { ...previous, payload: { exhaustAt: "2026-11-03T10:05:00.000Z" } };

        expect(rule.refire(previous, later, NOW)).toBe(false);
        expect(rule.refire(previous, muchEarlier, NOW)).toBe(true);
    });
});

describe("rules over the stores", () => {
    test("a window that disappears is one limit-state-change alert", () => {
        const record = (at: Date, availability: "limited" | "absent") =>
            limits.recordSnapshotV2("work", "five_hour", availability === "absent" ? 0 : 40, at.toISOString(), {
                resetsAt: null,
                severity: null,
                scopeModel: null,
                provider: "anthropic-sub",
                accountId: "acc_work",
                kind: "session",
                availability,
            });
        record(minutes(-30), "limited");
        record(minutes(-1), "absent");

        const built = buildAlertRound({
            db: limits.connection(),
            snapshots: [],
            now: NOW,
            previousRoundAt: minutes(-2).toISOString(),
            config: config(),
        });
        const candidates = ALERT_RULES["limit-state-change"].evaluate(built, ALERT_RULE_DEFAULTS["limit-state-change"]);

        expect(built.availabilityChanges).toMatchObject([{ bucket: "five_hour", from: "limited", to: "absent" }]);
        expect(candidates.map((candidate) => candidate.title)).toEqual(["A usage limit is gone"]);
    });

    test("health: a span nobody polled alerts once, and a backoff streak alerts once", async () => {
        const runs = new PollRunsStore(limits.connection());
        const held = snapshot(10, { error: "429", blocked: { until: minutes(30).toISOString(), failures: 2 } });
        runs.recordRound([{ snapshot: held, source: null }], NOW);
        const health = config({ rules: { health: { channels: ["inbox"] } } });
        const built = buildAlertRound({
            db: limits.connection(),
            snapshots: [held],
            now: NOW,
            previousRoundAt: minutes(-45).toISOString(),
            config: health,
        });

        const fired = await runAlertEngine({ round: built, config: health, store, channels, rules: ALERT_RULES });

        expect(fired.filter((alert) => alert.rule === "health").map((alert) => alert.dedupeKey)).toEqual([
            "health:poller-down",
            "health:backoff:anthropic-sub:acc_work",
        ]);
        expect(inbox.delivered.length).toBeGreaterThanOrEqual(2);

        runs.recordRound([{ snapshot: held, source: null }], minutes(1));
        const again = buildAlertRound({
            db: limits.connection(),
            snapshots: [held],
            now: minutes(1),
            previousRoundAt: NOW.toISOString(),
            config: health,
        });

        expect(
            (await runAlertEngine({ round: again, config: health, store, channels })).filter((a) => a.rule === "health")
        ).toEqual([]);
    });

    test("rate-limited: three answers in ten minutes alert, and the cooldown is named", () => {
        const events = new UsageEventsStore(limits.connection());

        for (const minute of [-8, -5, -2]) {
            events.insert({
                provider: "openai-sub",
                accountName: "shop",
                source: "ai-proxy",
                kind: "rate-limited",
                at: minutes(minute),
            });
        }

        events.insert({
            provider: "openai-sub",
            accountName: "shop",
            source: "ai-proxy",
            kind: "cooldown",
            retryAfterMs: 120_000,
            at: minutes(-2),
        });
        const built = buildAlertRound({
            db: limits.connection(),
            snapshots: [],
            now: NOW,
            previousRoundAt: null,
            config: config(),
        });
        const candidates = ALERT_RULES["rate-limited"].evaluate(built, ALERT_RULE_DEFAULTS["rate-limited"]);

        expect(candidates.map((candidate) => candidate.message)).toEqual([
            "shop got 3 rate-limit answers in 10 min (ai-proxy). It cools down for 120 s.",
        ]);
    });

    test("rate-limited: a window longer than an hour reads its events from the whole window", () => {
        const events = new UsageEventsStore(limits.connection());

        for (const minute of [-90, -70, -20]) {
            events.insert({
                provider: "openai-sub",
                accountName: "shop",
                source: "ai-proxy",
                kind: "rate-limited",
                at: minutes(minute),
            });
        }

        const settings = { ...ALERT_RULE_DEFAULTS["rate-limited"], windowMinutes: 120 };
        const built = buildAlertRound({
            db: limits.connection(),
            snapshots: [],
            now: NOW,
            previousRoundAt: null,
            config: config({ rules: { "rate-limited": { windowMinutes: 120 } } }),
        });

        expect(built.events).toHaveLength(3);
        expect(ALERT_RULES["rate-limited"].evaluate(built, settings).map((candidate) => candidate.message)).toEqual([
            "shop got 3 rate-limit answers in 120 min (ai-proxy).",
        ]);
    });

    test("rate-limited: an id-bearing and a name-only answer for one account count together", () => {
        const events = new UsageEventsStore(limits.connection());
        const insert = (minute: number, kind: "usage-429" | "rate-limited" | "cooldown", withId: boolean) =>
            events.insert({
                provider: "anthropic-sub",
                accountName: "work",
                ...(withId ? { accountId: "acc_work" } : {}),
                source: kind === "usage-429" ? "usage-client" : "ai-proxy",
                kind,
                ...(kind === "cooldown" ? { retryAfterMs: 60_000 } : {}),
                at: minutes(minute),
            });
        insert(-8, "usage-429", false);
        insert(-6, "usage-429", false);
        insert(-3, "rate-limited", true);
        insert(-3, "cooldown", false);
        const built = buildAlertRound({
            db: limits.connection(),
            snapshots: [snapshot(10)],
            now: NOW,
            previousRoundAt: null,
            config: config(),
        });
        const candidates = ALERT_RULES["rate-limited"].evaluate(built, ALERT_RULE_DEFAULTS["rate-limited"]);

        expect(candidates.map((candidate) => [candidate.dedupeKey, candidate.accountId, candidate.message])).toEqual([
            [
                "rate-limited:anthropic-sub:acc_work",
                "acc_work",
                "work got 3 rate-limit answers in 10 min (usage-client, ai-proxy). It cools down for 60 s.",
            ],
        ]);
    });
});

describe("the seed from the old notifier", () => {
    test("a threshold the notifier already announced this cycle is recorded as fired and does not burst again", async () => {
        const seeded = seedThresholdAlerts({
            store,
            trackers: { "acc_work:five_hour": { lastNotifiedThreshold: 80, lastResetEpoch: Date.parse(RESET) } },
            snapshots: [snapshot(85)],
            settings: ALERT_RULE_DEFAULTS.threshold,
            now: NOW,
        });

        expect(seeded).toBe(1);
        expect(
            await runAlertEngine({
                round: round({ now: minutes(1), snapshots: [snapshot(85)] }),
                config: config(),
                store,
                channels,
            })
        ).toEqual([]);
        expect(
            seedThresholdAlerts({
                store,
                trackers: {},
                snapshots: [],
                settings: ALERT_RULE_DEFAULTS.threshold,
                now: NOW,
            })
        ).toBe(0);
    });

    test("a window that failed on the first tick is seeded on the tick it recovers, not announced again", async () => {
        const side = (overrides: Partial<AccountUsageSnapshot>) =>
            snapshot(85, { accountId: "acc_side", accountName: "side", ...overrides });
        const trackers = {
            "acc_work:five_hour": { lastNotifiedThreshold: 80, lastResetEpoch: Date.parse(RESET) },
            "acc_side:five_hour": { lastNotifiedThreshold: 80, lastResetEpoch: Date.parse(RESET) },
        };
        const seed = (snapshots: AccountUsageSnapshot[], now: Date) =>
            seedThresholdAlerts({ store, trackers, snapshots, settings: ALERT_RULE_DEFAULTS.threshold, now });

        expect(seed([snapshot(85), side({ error: "usage endpoint 500", limits: [] })], NOW)).toBe(1);
        expect(seed([snapshot(85), side({})], minutes(1))).toBe(1);
        expect(
            await runAlertEngine({
                round: round({ now: minutes(2), snapshots: [snapshot(85), side({})] }),
                config: config(),
                store,
                channels,
            })
        ).toEqual([]);
        expect(seed([snapshot(85), side({})], minutes(3))).toBe(0);
    });

    test("a tracker from an older cycle seeds nothing, so the new cycle still alerts", () => {
        const seeded = seedThresholdAlerts({
            store,
            trackers: {
                "work:five_hour": { lastNotifiedThreshold: 80, lastResetEpoch: Date.parse(RESET) - 5 * 3_600_000 },
            },
            snapshots: [snapshot(85)],
            settings: ALERT_RULE_DEFAULTS.threshold,
            now: NOW,
        });

        expect(seeded).toBe(0);
    });
});

describe("config", () => {
    test("quiet hours wrap over midnight", () => {
        const quiet = { start: "22:00", end: "07:00" };
        const local = (hour: number) => {
            const date = new Date(NOW);
            date.setHours(hour, 30, 0, 0);
            return date;
        };

        expect(inQuietHours(quiet, local(23))).toBe(true);
        expect(inQuietHours(quiet, local(6))).toBe(true);
        expect(inQuietHours(quiet, local(12))).toBe(false);
        expect(inQuietHours(null, local(23))).toBe(false);
    });

    test("a saved rule keeps its other defaults, and the lead minutes merge per kind", () => {
        const merged = mergeAlertsConfig({ rules: { "predicted-exhaust": { leadMinutes: { session: 30 } } } });

        expect(merged.rules["predicted-exhaust"].leadMinutes).toEqual({ session: 30, weekly: 720, scoped: 360 });
        expect(merged.rules["predicted-exhaust"].channels).toEqual(["macos", "inbox"]);
    });

    test("a saved channel id the engine has no channel for is dropped, so delivery never meets it", async () => {
        // A hand-edited config file, read as the loader reads it: its ids are whatever the file says.
        const merged = mergeAlertsConfig(
            SafeJSON.parse('{"rules":{"threshold":{"channels":["telegram","inbox","Inbox"]}}}')
        );

        expect(merged.rules.threshold.channels).toEqual(["inbox"]);
    });

    test("a saved channels value that is no list takes the rule's default channels instead of throwing", async () => {
        const merged = mergeAlertsConfig(
            SafeJSON.parse('{"rules":{"threshold":{"channels":null},"health":{"channels":"inbox"}}}')
        );

        expect(merged.rules.threshold.channels).toEqual(ALERT_RULE_DEFAULTS.threshold.channels);
        expect(merged.rules.health.channels).toEqual(ALERT_RULE_DEFAULTS.health.channels);
    });
});

describe("budget rule", () => {
    const WEEK_RESET = "2026-11-06T10:00:00.000Z";
    const weekly = (percent: number): AccountUsageSnapshot =>
        snapshot(0, {
            limits: [{ key: "seven_day", label: "Week", kind: "weekly", percentUsed: percent, resetsAt: WEEK_RESET }],
        });
    const budgets = {
        global: {},
        providers: { "anthropic-sub": { accounts: { acc_work: { weekly: { reservePct: 15 } } } } },
    };
    const before: UsageSample = {
        provider: "anthropic-sub",
        account: "work",
        bucket: "seven_day",
        kind: "weekly",
        utilization: 30,
        resetsAt: WEEK_RESET,
        timestamp: "2026-11-02T20:00:00.000Z",
    };

    test("windowPace spreads what is left above the reserve over the days to the reset", () => {
        const pace = windowPace({
            budget: { reservePct: 10 },
            kind: "weekly",
            utilization: 50,
            resetsAt: "2026-11-05T00:00:00.000Z",
            samples: [{ ...before, utilization: 30, resetsAt: "2026-11-05T00:00:00.000Z" }],
            now: NOW,
            dayStart: new Date("2026-11-03T00:00:00.000Z"),
            overPaceFactor: 1.2,
        });

        expect(pace).toEqual({
            reservePct: 10,
            allowancePct: 30,
            burnedTodayPct: 20,
            paceRatio: 20 / 30,
            headroomPct: 40,
            status: "on-pace",
        });
    });

    test("a budgeted week burning past its allowance fires over pace; an unbudgeted one stays quiet", () => {
        const settings = ALERT_RULE_DEFAULTS.budget;
        const fired = ALERT_RULES.budget.evaluate(
            round({ snapshots: [weekly(60)], samples: [before], budgets }),
            settings
        );

        expect(fired.map((alert) => [alert.title, alert.dedupeKey])).toEqual([
            ["Over budget pace", "budget:over-pace:anthropic-sub:acc_work:seven_day"],
        ]);
        expect(ALERT_RULES.budget.evaluate(round({ snapshots: [weekly(60)], samples: [before] }), settings)).toEqual(
            []
        );
    });

    test("use it or lose it: a budgeted window resetting within 6 h with 40% left", () => {
        const soon = snapshot(0, {
            limits: [{ key: "seven_day", label: "Week", kind: "weekly", percentUsed: 30, resetsAt: RESET }],
        });
        const fired = ALERT_RULES.budget.evaluate(round({ snapshots: [soon], budgets }), ALERT_RULE_DEFAULTS.budget);

        expect(fired.map((alert) => [alert.title, alert.severity])).toEqual([["Use it or lose it", 70]]);
    });
});
