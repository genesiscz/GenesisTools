import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import type { UsageBudgets } from "@genesiscz/utils/ai/usage/budgets/budgets";
import type { UsageEventRow } from "@genesiscz/utils/ai/usage/events/store";
import type { ForecastWindowKind } from "@genesiscz/utils/ai/usage/forecast/forecast";
import type { UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import type { PollRun } from "@genesiscz/utils/ai/usage/poll-runs/store";

/**
 * The alert engine's shapes (design 2026-11-01, step U7, proposal 7). A rule says WHAT is worth an alert; the engine
 * owns dedupe, the record in `usage_alerts`, quiet hours and delivery; a channel says HOW it reaches the user. Rules
 * key on the window kind and never on a provider name, so a new provider edits no file here.
 */

/** Every rule's own settings. A new rule is one entry here, one in `ALERT_RULES`, and its defaults. */
export interface AlertRuleSettings {
    /** Today's percent thresholds, moved from `notifications.thresholds`. Scoped and monthly windows use `weekly`. */
    threshold: RuleSettingsBase & { session: number[]; weekly: number[] };
    /** The forecast says the window runs out before its reset, within the lead time of its kind. */
    "predicted-exhaust": RuleSettingsBase & {
        leadMinutes: Record<ForecastWindowKind, number>;
        /** Fire only for a window whose use rose within `activeMinutes`: an account someone is working on. */
        requireActive: boolean;
        activeMinutes: number;
    };
    /** A window appeared or disappeared (an account lost or regained its 5-hour limit). */
    "limit-state-change": RuleSettingsBase;
    /** The poller missed a span, an account was held back or refused, or a credential runs out soon. */
    health: RuleSettingsBase & { downMinutes: number; refreshExpiryDays: number };
    /** Several rate-limit answers for one account within a few minutes. */
    "rate-limited": RuleSettingsBase & { count: number; windowMinutes: number };
    /**
     * A window with a budget (proposal 18) burns faster today than its allowance (`overPaceFactor` times it) or
     * dropped below its reserve; and "use it or lose it": a window resets within `useItHours` with at least
     * `useItMinLeftPct` left (only a budgeted window unless `useItBudgetedOnly` is false).
     */
    budget: RuleSettingsBase & {
        overPaceFactor: number;
        useItHours: number;
        useItMinLeftPct: number;
        useItBudgetedOnly: boolean;
    };
}

export type AlertRuleId = keyof AlertRuleSettings;

export const ALERT_RULE_IDS: readonly AlertRuleId[] = [
    "threshold",
    "predicted-exhaust",
    "limit-state-change",
    "health",
    "rate-limited",
    "budget",
];

export function isAlertRuleId(value: string): value is AlertRuleId {
    return (ALERT_RULE_IDS as readonly string[]).includes(value);
}

/** Where an alert goes. A new channel is one entry here and one in the door's channel table. */
export type AlertChannelId = "macos" | "inbox";

export const ALERT_CHANNEL_IDS: readonly AlertChannelId[] = ["macos", "inbox"];

export interface RuleSettingsBase {
    enabled: boolean;
    /** Channels this rule delivers to. Empty: recorded only (the feed and `tools ai usage alerts` still show it). */
    channels: AlertChannelId[];
}

export type AlertLevel = "info" | "warning" | "critical";

/** One thing a rule found this round. The engine decides whether it fires. */
export interface AlertCandidate {
    rule: AlertRuleId;
    provider: string | null;
    accountId: string | null;
    accountName: string | null;
    windowKind: string | null;
    windowKey: string | null;
    /** Same key, same thing: the engine asks the rule's `refire` before firing it again. */
    dedupeKey: string;
    /** What re-arms the alert (a window's reset, a change's instant); null when only `refire` decides. */
    cycle: string | null;
    /** Rule-specific rank; most rules re-fire within a cycle only when it rises. */
    severity: number;
    level: AlertLevel;
    title: string;
    message: string;
    payload?: Record<string, unknown>;
}

/** A row of `usage_alerts`. */
export interface StoredAlert extends AlertCandidate {
    id: number;
    /** ISO UTC. */
    firedAt: string;
    /** Channels it was delivered to. */
    channels: AlertChannelId[];
    ackAt: string | null;
}

/** A window that appeared or disappeared since the last round, read from the stored availability. */
export interface AvailabilityChange {
    provider: string;
    accountId: string | null;
    accountName: string;
    bucket: string;
    kind: string | null;
    /** ISO UTC of the row that recorded the new state. */
    at: string;
    from: "limited" | "absent";
    to: "limited" | "absent";
}

/** Everything a rule may read about one round. Read once per tick by the door, so each rule stays a pure function. */
export interface AlertRound {
    now: Date;
    /** This round's snapshots. Stale and error rows are there too; each rule decides what it trusts. */
    snapshots: readonly AccountUsageSnapshot[];
    /** Readings of the lookback (3 days), for the forecast. */
    samples: readonly UsageSample[];
    /** Poll runs of the last day, this round's included. */
    runs: readonly PollRun[];
    /** The end of the last round recorded before this one; null before the first. */
    previousRoundAt: string | null;
    /** Usage events of the last hour. */
    events: readonly UsageEventRow[];
    availabilityChanges: readonly AvailabilityChange[];
    /** The budgets of the usage config, read once per tick (empty when none are set). */
    budgets: UsageBudgets;
}

export interface UsageAlertRule<Id extends AlertRuleId> {
    id: Id;
    /** One line for `alerts rules`. */
    description: string;
    defaults: AlertRuleSettings[Id];
    evaluate(round: AlertRound, settings: AlertRuleSettings[Id]): AlertCandidate[];
    /** Whether a candidate fires again after `previous`, the last alert with its dedupe key. */
    refire(previous: StoredAlert, next: AlertCandidate, now: Date): boolean;
}

export type AlertRuleTable = { [Id in AlertRuleId]: UsageAlertRule<Id> };

export interface AlertChannel {
    id: AlertChannelId;
    /** A channel that interrupts (a banner, a sound) is held during quiet hours; the alert is still recorded. */
    interrupts: boolean;
    deliver(alert: StoredAlert): Promise<void>;
}

export type AlertChannelTable = Record<AlertChannelId, AlertChannel>;
