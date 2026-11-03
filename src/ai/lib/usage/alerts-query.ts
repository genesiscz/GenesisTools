import type { Database } from "bun:sqlite";
import { alertChannels } from "@app/ai/lib/usage/alert-channels";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import { deliveryChannels, type UsageAlertsConfig } from "@genesiscz/utils/ai/usage/alerts/config";
import { judgeRound } from "@genesiscz/utils/ai/usage/alerts/engine";
import { UsageAlertsStore } from "@genesiscz/utils/ai/usage/alerts/log";
import { buildAlertRound } from "@genesiscz/utils/ai/usage/alerts/round";
import { ALERT_RULES } from "@genesiscz/utils/ai/usage/alerts/rules";
import {
    ALERT_CHANNEL_IDS,
    ALERT_RULE_IDS,
    type AlertCandidate,
    type AlertChannelId,
    type AlertChannelTable,
    type AlertRuleId,
    isAlertRuleId,
    type StoredAlert,
} from "@genesiscz/utils/ai/usage/alerts/types";
import {
    type AccountKey,
    resolveProviderList,
    resolveWindow,
    splitList,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
    type WindowFlags,
} from "@genesiscz/utils/ai/usage/contract";
import { PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import { loadDashboardConfig, type UsageDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { snapshotsFromCache } from "@genesiscz/utils/ai/usage-poll/limits-now";
import { logger } from "@genesiscz/utils/logger";

/**
 * The answers behind `tools ai usage alerts list | ack | rules | test` (design 2026-11-01, step U7). `list`, `rules`
 * and `test` are diagnostics: they read through a read-only connection and the read-only config path, and `test`
 * judges the last poll's snapshots without polling, recording or delivering. `ack` is the one verb that writes.
 */

export interface AlertsListOptions extends WindowFlags {
    provider?: string[] | boolean;
    account?: string[];
    rule?: string[] | boolean;
    unacked?: boolean;
    json?: boolean;
}

export interface AlertsListData {
    alerts: StoredAlert[];
    /** Open alerts in the window (the popover's "N alerts" capsule). */
    unacked: number;
}

export interface AlertRuleView {
    id: AlertRuleId;
    description: string;
    enabled: boolean;
    channels: AlertChannelId[];
    /** The rule's full settings as they apply now (defaults under the saved values). */
    settings: Record<string, unknown>;
    /** Providers that turn this rule off. */
    offFor: string[];
}

export interface AlertRulesData {
    enabled: boolean;
    quietHours: UsageAlertsConfig["global"]["quietHours"];
    channels: AlertChannelId[];
    rules: AlertRuleView[];
}

export interface JudgedView extends AlertCandidate {
    fires: boolean;
    previous: { id: number; firedAt: string; severity: number } | null;
    /** The channels it would go to now. */
    channels: AlertChannelId[];
}

export interface AlertTestData {
    rule: AlertRuleId;
    enabled: boolean;
    candidates: JudgedView[];
    /** With `--send`: the channels each test delivery went to. */
    sent?: AlertChannelId[];
}

export interface QueryDeps {
    open?: () => Database | undefined;
    now?: Date;
    config?: () => Promise<UsageDashboardConfig>;
}

export const ALERTS_LIST_SCHEMA = { verb: "alerts", version: 1 } as const;
export const ALERTS_ACK_SCHEMA = { verb: "alerts.ack", version: 1 } as const;
export const ALERTS_RULES_SCHEMA = { verb: "alerts.rules", version: 1 } as const;
export const ALERTS_TEST_SCHEMA = { verb: "alerts.test", version: 1 } as const;

const NO_STORE: UsageWarning = {
    code: "no-store",
    message: "No usage store exists here yet, so no alert was recorded.",
};

function readOnlyConfig(deps: QueryDeps): Promise<UsageDashboardConfig> {
    return (deps.config ?? (() => loadDashboardConfig({ readOnly: true })))();
}

export function resolveRules(raw: string[] | boolean | undefined): AlertRuleId[] | undefined {
    const enumFlag = { flag: "--rule", values: ALERT_RULE_IDS };

    if (raw === true) {
        throw new UsageQueryError("bad-value", `--rule needs a value: ${ALERT_RULE_IDS.join(" | ")}.`, { enumFlag });
    }

    const list = splitList(raw);
    const unknown = list.find((value) => !isAlertRuleId(value));

    if (unknown !== undefined) {
        throw new UsageQueryError("bad-value", `"${unknown}" is not an alert rule: ${ALERT_RULE_IDS.join(" | ")}.`, {
            given: unknown,
            enumFlag,
        });
    }

    return list.length === 0 ? undefined : list.filter(isAlertRuleId);
}

function keysOf(alerts: readonly Pick<AlertCandidate, "provider" | "accountId" | "accountName">[]): AccountKey[] {
    const keys = new Map<string, AccountKey>();

    for (const alert of alerts) {
        if (alert.provider !== null && alert.accountName !== null) {
            keys.set(`${alert.provider}\u0000${alert.accountName}`, {
                provider: alert.provider,
                accountId: alert.accountId ?? alert.accountName,
                accountName: alert.accountName,
            });
        }
    }

    return [...keys.values()];
}

/** `tools ai usage alerts` / `alerts list`: the alerts fired in the window, newest first, as `usage.alerts@1`. */
export async function queryAlerts(
    opts: AlertsListOptions,
    deps: QueryDeps = {}
): Promise<UsageEnvelope<AlertsListData>> {
    const now = deps.now ?? new Date();
    const window = resolveWindow(opts, { now, defaultSince: "7d" });
    const providers = resolveProviderList(opts.provider);
    const rules = resolveRules(opts.rule);
    const accounts = splitList(opts.account);
    const db = (deps.open ?? (() => openHistoryReadOnly()))();
    let alerts: StoredAlert[] = [];

    try {
        if (db) {
            alerts = new UsageAlertsStore(db).list({
                from: window.from,
                to: window.to,
                ...(providers === undefined ? {} : { providers }),
                ...(rules === undefined ? {} : { rules }),
                ...(accounts.length === 0 ? {} : { accounts }),
                ...(opts.unacked ? { unackedOnly: true } : {}),
            });
        }
    } finally {
        db?.close();
    }

    return usageEnvelope({
        ...ALERTS_LIST_SCHEMA,
        now,
        window,
        accounts: keysOf(alerts),
        data: { alerts, unacked: alerts.filter((alert) => alert.ackAt === null).length },
        warnings: db ? [] : [NO_STORE],
    });
}

/** `tools ai usage alerts ack <id...> | --all`: marks alerts acknowledged; the only alerts verb that writes. */
export function ackAlerts(
    opts: { ids: readonly string[]; all?: boolean },
    deps: { db?: UsageLimitsDb; now?: Date } = {}
): UsageEnvelope<{ acked: number }> {
    if (opts.all && opts.ids.length > 0) {
        throw new UsageQueryError("bad-value", "Pass alert ids or --all, not both.");
    }

    if (!opts.all && opts.ids.length === 0) {
        throw new UsageQueryError("bad-value", "Pass the alert ids to acknowledge, or --all.");
    }

    const ids = opts.ids.map((raw) => {
        const id = Number(raw);

        if (!Number.isInteger(id) || id < 1) {
            throw new UsageQueryError("bad-value", `"${raw}" is not an alert id.`, { given: raw });
        }

        return id;
    });
    const now = deps.now ?? new Date();
    const db = deps.db ?? new UsageLimitsDb();

    try {
        const acked = new UsageAlertsStore(db.connection()).ack({ ...(opts.all ? {} : { ids }), at: now });
        logger.debug({ acked, ids: opts.all ? "all" : ids }, "[ai-usage] alerts acknowledged");
        return usageEnvelope({ ...ALERTS_ACK_SCHEMA, now, accounts: [], data: { acked } });
    } finally {
        if (!deps.db) {
            db.close();
        }
    }
}

/** `tools ai usage alerts rules`: every rule with its settings as they apply now, as `usage.alerts.rules@1`. */
export async function queryAlertRules(deps: QueryDeps = {}): Promise<UsageEnvelope<AlertRulesData>> {
    const config = (await readOnlyConfig(deps)).alerts;
    const rules = ALERT_RULE_IDS.map((id): AlertRuleView => {
        const { enabled, channels, ...settings } = config.rules[id];

        return {
            id,
            description: ALERT_RULES[id].description,
            enabled,
            channels,
            settings,
            offFor: Object.entries(config.providers)
                .filter(([, override]) => override.rules?.[id]?.enabled === false)
                .map(([provider]) => provider),
        };
    });

    return usageEnvelope({
        ...ALERTS_RULES_SCHEMA,
        now: deps.now ?? new Date(),
        accounts: [],
        data: {
            enabled: config.global.enabled,
            quietHours: config.global.quietHours,
            channels: [...ALERT_CHANNEL_IDS],
            rules,
        },
    });
}

export interface AlertTestOptions {
    account?: string[];
    send?: boolean;
    json?: boolean;
}

function testAlert(rule: AlertRuleId, candidate: AlertCandidate | undefined, now: Date): StoredAlert {
    const base: AlertCandidate = candidate ?? {
        rule,
        provider: null,
        accountId: null,
        accountName: null,
        windowKind: null,
        windowKey: null,
        dedupeKey: `test:${rule}`,
        cycle: null,
        severity: 0,
        level: "info",
        title: "Usage alert test",
        message: `A test of the ${rule} rule's channels. Nothing fired.`,
    };

    return { ...base, id: 0, firedAt: now.toISOString(), channels: [], ackAt: now.toISOString() };
}

/**
 * `tools ai usage alerts test <rule>`: what the rule finds in the last poll's snapshots and whether the engine would
 * fire it now, as `usage.alerts.test@1`. Never polls and never records. `--send` delivers the findings (or one test
 * card when there are none) through the rule's channels, so a channel can be checked by hand.
 */
export async function testAlertRule(
    ruleArg: string,
    opts: AlertTestOptions,
    deps: QueryDeps & { channels?: AlertChannelTable } = {}
): Promise<UsageEnvelope<AlertTestData>> {
    const [rule] = resolveRules([ruleArg]) ?? [];

    if (rule === undefined) {
        throw new UsageQueryError("bad-value", `Name a rule: ${ALERT_RULE_IDS.join(" | ")}.`);
    }

    const now = deps.now ?? new Date();
    const dashboard = await readOnlyConfig(deps);
    const accounts = new Set(splitList(opts.account));
    const snapshots = snapshotsFromCache(await readSnapshotsCache()).filter(
        (snapshot) => accounts.size === 0 || accounts.has(snapshot.accountName) || accounts.has(snapshot.accountId)
    );
    const db = (deps.open ?? (() => openHistoryReadOnly()))();
    const warnings: UsageWarning[] = [];
    let judged: ReturnType<typeof judgeRound> = [];

    try {
        if (db) {
            const round = buildAlertRound({
                db,
                snapshots,
                now,
                previousRoundAt: new PollRunsStore(db).lastRoundAt(),
            });
            judged = judgeRound({ round, config: dashboard.alerts, store: new UsageAlertsStore(db), only: [rule] });
        } else {
            warnings.push(NO_STORE);
        }
    } finally {
        db?.close();
    }

    const enabled = dashboard.alerts.global.enabled && dashboard.alerts.rules[rule].enabled;

    if (!enabled) {
        warnings.push({
            code: "rule-off",
            message: `The ${rule} rule is off, so the engine evaluates nothing for it.`,
        });
    }

    const table = deps.channels ?? alertChannels(dashboard.notifications);
    const channelsNow = deliveryChannels({
        config: dashboard.alerts,
        rule,
        now,
        interrupts: (channel) => table[channel].interrupts,
    });
    const candidates = judged.map(({ candidate, fires, previous }) => ({
        ...candidate,
        fires,
        previous: previous ? { id: previous.id, firedAt: previous.firedAt, severity: previous.severity } : null,
        channels: channelsNow,
    }));
    const data: AlertTestData = { rule, enabled, candidates };

    if (opts.send) {
        const cards = judged.length > 0 ? judged.map((entry) => entry.candidate) : [undefined];

        for (const card of cards) {
            for (const channel of channelsNow) {
                await table[channel].deliver(testAlert(rule, card, now));
            }
        }

        data.sent = channelsNow;
    }

    return usageEnvelope({
        ...ALERTS_TEST_SCHEMA,
        now,
        accounts: keysOf(candidates),
        data,
        warnings,
    });
}
