import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { EMPTY_BUDGETS } from "@genesiscz/utils/ai/usage/budgets/budgets";
import type { NotifiedThreshold } from "@genesiscz/utils/ai/usage-poll/notifications";
import type { UsageAlertsStore } from "./log";
import { RESET_JITTER_MS } from "./refire";
import { thresholdRule } from "./rules/threshold";
import type { AlertRound, AlertRuleSettings } from "./types";

/**
 * Carries the old notifier's memory into the alert record, once. Without it, the first tick of the engine finds no
 * threshold alert at all and fires a banner for every window already over a threshold, the burst the notifier's own
 * legacy read existed to prevent.
 *
 * Per window, not per store: a candidate whose dedupe key already has a row in `usage_alerts` is the engine's from
 * then on and is skipped. Any other threshold candidate of the round whose tracker (keyed `<accountId>:<key>`, or the
 * older `<accountName>:<key>`) already notified this reset cycle at that level or higher gets an acknowledged,
 * undelivered alert at the tracker's level, so the engine treats it as fired. A window that failed or sat below its
 * threshold on the first tick is still seeded on the tick it first qualifies.
 */
export function seedThresholdAlerts(input: {
    store: UsageAlertsStore;
    trackers: Readonly<Record<string, NotifiedThreshold>>;
    snapshots: readonly AccountUsageSnapshot[];
    settings: AlertRuleSettings["threshold"];
    now: Date;
}): number {
    const round: AlertRound = {
        now: input.now,
        snapshots: input.snapshots,
        samples: [],
        baselines: [],
        runs: [],
        previousRoundAt: null,
        lastEvaluatedAt: null,
        events: [],
        availabilityChanges: [],
        budgets: EMPTY_BUDGETS,
    };
    let seeded = 0;

    for (const candidate of thresholdRule.evaluate(round, input.settings)) {
        if (input.store.latestByDedupe(candidate.dedupeKey)) {
            continue;
        }

        const tracker =
            input.trackers[`${candidate.accountId}:${candidate.windowKey}`] ??
            input.trackers[`${candidate.accountName}:${candidate.windowKey}`];
        const level = tracker?.lastNotifiedThreshold;

        if (level === null || level === undefined) {
            continue;
        }

        const reset = candidate.cycle === null ? Number.NaN : Date.parse(candidate.cycle);
        const sameCycle =
            tracker.lastResetEpoch === null ||
            !Number.isFinite(reset) ||
            Math.abs(reset - tracker.lastResetEpoch) <= RESET_JITTER_MS;

        if (!sameCycle) {
            continue;
        }

        input.store.insert(
            { ...candidate, severity: level, payload: { ...candidate.payload, seededFrom: "notification-tracker" } },
            { firedAt: input.now, channels: [], ackAt: input.now }
        );
        seeded++;
    }

    return seeded;
}
