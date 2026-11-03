import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ackAlerts, queryAlertRules, queryAlerts, testAlertRule } from "@app/ai/lib/usage/alerts-query";
import { recordRoundAndAlert } from "@app/ai/lib/usage/alerts-tick";
import { queryEvents } from "@app/ai/lib/usage/events-query";
import { queryHealth } from "@app/ai/lib/usage/limits-query";
import { mergeAlertsConfig } from "@genesiscz/utils/ai/usage/alerts/config";
import { UsageAlertsStore } from "@genesiscz/utils/ai/usage/alerts/log";
import type { AlertChannel, AlertChannelTable, StoredAlert } from "@genesiscz/utils/ai/usage/alerts/types";
import { UsageQueryError } from "@genesiscz/utils/ai/usage/contract";
import { UsageEventsStore } from "@genesiscz/utils/ai/usage/events/store";
import { PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import type { UsageDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { removeDbFile } from "@genesiscz/utils/fs";
import { tmpdir } from "@genesiscz/utils/paths";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * The doors of steps U5 to U7 over a migrated store file: each answers its `usage.<verb>@1` envelope through a
 * read-only connection, the diagnostics never write, and `ack` is the one verb that does. Handles are invented.
 */

const NOW = new Date("2026-11-03T10:00:00.000Z");
let counter = 0;
let path: string;
let limits: UsageLimitsDb;

function readOnly(): Database {
    return new Database(path, { readonly: true });
}

function dashboard(alerts: Parameters<typeof mergeAlertsConfig>[0] = {}): UsageDashboardConfig {
    return {
        refreshInterval: 60,
        prominentBuckets: {},
        hiddenBuckets: {},
        hiddenAccounts: [],
        defaultTab: 0,
        historyLayout: "stacked",
        notifications: { enabled: true, inTui: true, macos: true, sound: "Purr" },
        alerts: mergeAlertsConfig(alerts),
        dataRetentionDays: 30,
        paceScope: "pooled",
    };
}

function alert(store: UsageAlertsStore, account: string, firedAt: Date): StoredAlert {
    return store.insert(
        {
            rule: "threshold",
            provider: "anthropic-sub",
            accountId: `acc_${account}`,
            accountName: account,
            windowKind: "session",
            windowKey: "five_hour",
            dedupeKey: `threshold:anthropic-sub:acc_${account}:five_hour`,
            cycle: "2026-11-03T13:00:00.000Z",
            severity: 80,
            level: "critical",
            title: "AI Usage Alert",
            message: `${account}: 5h 85%`,
        },
        { firedAt, channels: ["macos"] }
    );
}

beforeEach(() => {
    path = join(tmpdir(), `ai-usage-doors-${process.pid}-${++counter}.sqlite`);
    limits = new UsageLimitsDb(path);
});

afterEach(() => {
    limits.close();
    removeDbFile(path);
});

describe("tools ai usage alerts", () => {
    test("list answers usage.alerts@1 with the open count, filtered by rule and account", async () => {
        const store = new UsageAlertsStore(limits.connection());
        alert(store, "work", new Date(NOW.getTime() - 60_000));
        alert(store, "shop", new Date(NOW.getTime() - 120_000));

        const envelope = await queryAlerts({ account: ["work"], rule: ["threshold"] }, { open: readOnly, now: NOW });

        expect(envelope.schema).toBe("usage.alerts@1");
        expect(envelope.data.unacked).toBe(1);
        expect(envelope.data.alerts.map((row) => row.accountName)).toEqual(["work"]);
        expect(envelope.selector.accounts).toEqual([
            { provider: "anthropic-sub", accountId: "acc_work", accountName: "work" },
        ]);
    });

    test("an unknown rule is refused with the value list", async () => {
        const refusal = await queryAlerts({ rule: ["nope"] }, { open: readOnly, now: NOW }).catch(
            (err: unknown) => err
        );

        expect(refusal).toBeInstanceOf(UsageQueryError);
        expect(refusal).toMatchObject({ details: { given: "nope", enumFlag: { flag: "--rule" } } });
    });

    test("ack marks the named alerts once and refuses a call with nothing to acknowledge", () => {
        const store = new UsageAlertsStore(limits.connection());
        const first = alert(store, "work", NOW);
        alert(store, "shop", NOW);

        expect(ackAlerts({ ids: [String(first.id)] }, { db: limits, now: NOW }).data).toEqual({ acked: 1 });
        expect(ackAlerts({ ids: [], all: true }, { db: limits, now: NOW }).data).toEqual({ acked: 1 });
        expect(() => ackAlerts({ ids: [] }, { db: limits, now: NOW })).toThrow(UsageQueryError);
        expect(() => ackAlerts({ ids: ["x"] }, { db: limits, now: NOW })).toThrow(UsageQueryError);
    });

    test("rules shows each rule's settings as they apply, with the providers that turn it off", async () => {
        const config = dashboard({ providers: { "openai-sub": { rules: { "rate-limited": { enabled: false } } } } });
        const envelope = await queryAlertRules({ config: async () => config, now: NOW });
        const rateLimited = envelope.data.rules.find((rule) => rule.id === "rate-limited");

        expect(envelope.schema).toBe("usage.alerts.rules@1");
        expect(envelope.data.rules.map((rule) => rule.id)).toEqual([
            "threshold",
            "predicted-exhaust",
            "limit-state-change",
            "health",
            "rate-limited",
        ]);
        expect(rateLimited).toMatchObject({ enabled: true, channels: ["inbox"], offFor: ["openai-sub"] });
        expect(rateLimited?.settings).toEqual({ count: 3, windowMinutes: 10 });
    });

    test("test judges one rule without recording, and --send tries the rule's channels", async () => {
        new PollRunsStore(limits.connection()).recordRound(
            [
                {
                    snapshot: {
                        provider: "anthropic-sub",
                        accountId: "acc_work",
                        accountName: "work",
                        fetchedAt: "",
                        limits: [],
                    },
                    source: "endpoint",
                },
            ],
            new Date(NOW.getTime() - 40 * 60_000)
        );
        const delivered: StoredAlert[] = [];
        const inbox: AlertChannel = {
            id: "inbox",
            interrupts: false,
            deliver: async (card) => void delivered.push(card),
        };
        const macos: AlertChannel = { id: "macos", interrupts: true, deliver: async () => {} };
        const channels: AlertChannelTable = { inbox, macos };
        const config = dashboard({ rules: { health: { channels: ["inbox"] } } });

        const envelope = await testAlertRule(
            "health",
            { send: true },
            { open: readOnly, now: NOW, config: async () => config, channels }
        );

        expect(envelope.schema).toBe("usage.alerts.test@1");
        expect(envelope.data.candidates.map((candidate) => [candidate.dedupeKey, candidate.fires])).toEqual([
            ["health:poller-down", true],
        ]);
        expect(envelope.data.sent).toEqual(["inbox"]);
        expect(delivered.map((card) => card.title)).toEqual(["Usage was not measured"]);
        expect(new UsageAlertsStore(limits.connection()).hasRule("health")).toBe(false);
    });
});

describe("tools ai usage events and limits health", () => {
    test("events answers usage.events@1 with counts per kind", async () => {
        const store = new UsageEventsStore(limits.connection());
        store.insert({
            provider: "anthropic-sub",
            accountName: "work",
            source: "usage-client",
            kind: "usage-429",
            at: NOW,
        });
        store.bumpDaily({
            provider: "anthropic-sub",
            accountName: "work",
            model: "haiku",
            source: "probe-budget",
            kind: "probe",
            day: "2026-11-03",
            by: 4,
            at: NOW,
        });

        const envelope = await queryEvents({ since: "1h" }, { open: readOnly, now: new Date(NOW.getTime() + 60_000) });

        expect(envelope.schema).toBe("usage.events@1");
        expect(envelope.data.counts).toEqual({ "usage-429": 1, probe: 4 });
        expect(envelope.window?.label).toBe("since 1h");
    });

    test("a missing store is a warning on every diagnostic door, never a crash", async () => {
        const none = () => undefined;

        expect((await queryEvents({}, { open: none, now: NOW })).warnings.map((w) => w.code)).toEqual(["no-store"]);
        expect((await queryAlerts({}, { open: none, now: NOW })).warnings.map((w) => w.code)).toEqual(["no-store"]);

        const health = await queryHealth({}, { open: none, now: NOW, heartbeatAgeMs: () => null });

        expect(health.schema).toBe("usage.limits.health@1");
        expect(health.warnings.map((w) => w.code)).toEqual(["daemon-down", "no-runs"]);
    });

    test("health reads the recorded rounds through the read-only connection", async () => {
        new PollRunsStore(limits.connection()).recordRound(
            [
                {
                    snapshot: {
                        provider: "anthropic-sub",
                        accountId: "acc_work",
                        accountName: "work",
                        fetchedAt: "",
                        limits: [],
                    },
                    source: "endpoint",
                },
            ],
            new Date(NOW.getTime() - 60_000)
        );

        const health = await queryHealth({ since: "1h" }, { open: readOnly, now: NOW, heartbeatAgeMs: () => 20_000 });

        expect(health.data.daemon).toEqual({
            heartbeatAgeMs: 20_000,
            alive: true,
            lastRoundAt: new Date(NOW.getTime() - 60_000).toISOString(),
        });
        expect(health.warnings).toEqual([]);
    });
});

describe("the daemon tick", () => {
    test("records the round's runs, seeds from the old trackers on the first tick, and fires only what is new", async () => {
        const delivered: StoredAlert[] = [];
        const macos: AlertChannel = {
            id: "macos",
            interrupts: true,
            deliver: async (card) => void delivered.push(card),
        };
        const inbox: AlertChannel = {
            id: "inbox",
            interrupts: false,
            deliver: async (card) => void delivered.push(card),
        };
        const window = (key: string, kind: "session" | "weekly", percent: number) => ({
            key,
            label: key,
            kind,
            percentUsed: percent,
            resetsAt: "2026-11-03T13:00:00.000Z",
        });
        const work = {
            provider: "anthropic-sub",
            accountId: "acc_work",
            accountName: "work",
            fetchedAt: NOW.toISOString(),
            limits: [window("five_hour", "session", 85), window("seven_day", "weekly", 45)],
        };
        const tick = (now: Date) =>
            recordRoundAndAlert({
                db: limits,
                snapshots: [work],
                config: dashboard(),
                storage: new Storage("ai-usage"),
                now,
                channels: { macos, inbox },
                // The notifier already announced 80 % on the 5h window this cycle; the weekly one never.
                trackers: async () => ({
                    "acc_work:five_hour": {
                        lastNotifiedThreshold: 80,
                        lastResetEpoch: Date.parse("2026-11-03T13:00:00.000Z"),
                    },
                }),
            });

        const first = await tick(NOW);

        expect(first.runs).toEqual({ extended: 0, started: 1 });
        expect(first.seeded).toBe(1);
        expect(first.fired.map((alert) => `${alert.windowKey}@${alert.severity}`)).toEqual(["seven_day@40"]);

        const second = await tick(new Date(NOW.getTime() + 60_000));

        expect(second).toMatchObject({ runs: { extended: 1, started: 0 }, seeded: 0, fired: [] });
        expect(delivered.map((card) => card.windowKey)).toEqual(["seven_day"]);
    });
});
