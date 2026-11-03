import type { LimitKind } from "@genesiscz/utils/ai/providers/account-features";
import { ALERT_RULE_DEFAULTS } from "../config";
import { refireOnNewCycleOrHigherSeverity } from "../refire";
import type { AlertCandidate, AlertRuleSettings, UsageAlertRule } from "../types";
import { notifiableWindows } from "../windows";

/**
 * Which threshold list a window uses, keyed by its kind (spec section 6.1). A kind with no entry never alerts: a
 * credit balance is money, not a rate limit.
 */
const THRESHOLD_LIST: Partial<Record<LimitKind, "session" | "weekly">> = {
    session: "session",
    weekly: "weekly",
    scoped: "weekly",
    monthly: "weekly",
};

/** At or above this a threshold alert is critical; the notifier used the same line. */
const CRITICAL_PCT = 80;

/**
 * The old notifier's rule, moved (proposal 7): a window crossed one of its thresholds. It fires for the highest
 * threshold crossed, once per reset cycle, and again in the same cycle only when a higher one is crossed.
 */
export const thresholdRule: UsageAlertRule<"threshold"> = {
    id: "threshold",
    description:
        "A window crossed one of its percent thresholds (session list; weekly list for weekly, scoped, monthly)",
    defaults: ALERT_RULE_DEFAULTS.threshold,
    evaluate(round, settings: AlertRuleSettings["threshold"]) {
        const candidates: AlertCandidate[] = [];

        for (const window of notifiableWindows(round.snapshots)) {
            const list = THRESHOLD_LIST[window.kind];

            if (!list) {
                continue;
            }

            const crossed = settings[list].filter((threshold) => window.utilization >= threshold);

            if (crossed.length === 0) {
                continue;
            }

            const highest = Math.max(...crossed);
            candidates.push({
                rule: "threshold",
                provider: window.provider,
                accountId: window.accountId,
                accountName: window.accountName,
                windowKind: window.kind,
                windowKey: window.key,
                dedupeKey: `threshold:${window.provider}:${window.accountId}:${window.key}`,
                cycle: window.resetsAt,
                severity: highest,
                level: window.utilization >= CRITICAL_PCT ? "critical" : "warning",
                title: "AI Usage Alert",
                message: `${window.accountName}: ${window.label} ${Math.round(window.utilization)}%`,
                payload: { threshold: highest, utilization: window.utilization, resetsAt: window.resetsAt },
            });
        }

        return candidates;
    },
    refire: refireOnNewCycleOrHigherSeverity,
};
