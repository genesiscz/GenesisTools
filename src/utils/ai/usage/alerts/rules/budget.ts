import { localDayStart, windowBudgetFor, windowPace } from "@genesiscz/utils/ai/usage/budgets/budgets";
import { ALERT_RULE_DEFAULTS } from "../config";
import { refireOnNewCycleOrHigherSeverity } from "../refire";
import type { AlertCandidate, AlertRound, AlertRuleSettings, UsageAlertRule } from "../types";
import { notifiableWindows } from "../windows";

const HOUR_MS = 3_600_000;

/** One window's readings, oldest first, after its last reading before the lookback (its baseline). */
function samplesOf(round: AlertRound, window: { provider: string; account: string; bucket: string }) {
    return [...round.baselines, ...round.samples]
        .filter(
            (sample) =>
                sample.provider === window.provider &&
                sample.account === window.account &&
                sample.bucket === window.bucket
        )
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

/**
 * A pace alert's severity, in steps: the raw ratio or depth moves with every reading, and the shared refire fires
 * again at any higher severity, so a raw value fired many times a day. Over pace steps by whole multiples of the
 * allowance, into the reserve by 5 points.
 */
function paceSeverity(over: boolean, pace: { paceRatio: number | null; headroomPct: number }): number {
    return over ? Math.max(1, Math.floor(pace.paceRatio ?? 1)) : Math.floor((100 - pace.headroomPct) / 5) * 5;
}

function overPaceMessage(
    account: string,
    label: string,
    pace: { burnedTodayPct: number | null; allowancePct: number | null; paceRatio: number | null }
): string {
    const burned = `${account}: ${label} used ${pace.burnedTodayPct?.toFixed(1)} points today`;

    // A zero allowance has no ratio: any burn is over it.
    if (pace.paceRatio === null) {
        return `${burned}, with no daily allowance.`;
    }

    return `${burned}, allowance ${pace.allowancePct?.toFixed(1)} (${pace.paceRatio.toFixed(1)}x).`;
}

/**
 * Proposal 18's rule over the budgets of the usage config: "over pace" when a budgeted window burns more today than
 * its allowance allows, "under reserve" when it ate into the part the user keeps, and "use it or lose it" when a
 * window resets soon with much left. A pace alert fires once per local day, "use it" once per reset cycle, and again
 * only at a higher severity. Spend targets in dollars are not judged here: a round carries no spend; `tools ai usage budgets` shows
 * them.
 */
export const budgetRule: UsageAlertRule<"budget"> = {
    id: "budget",
    description: "A budgeted window burns over its daily allowance or under its reserve, or resets soon with much left",
    defaults: ALERT_RULE_DEFAULTS.budget,
    evaluate(round, settings: AlertRuleSettings["budget"]) {
        const candidates: AlertCandidate[] = [];
        const dayStart = localDayStart(round.now);
        const day = dayStart.toISOString();

        for (const window of notifiableWindows(round.snapshots)) {
            const budget = windowBudgetFor(round.budgets, window);
            const base = {
                rule: "budget" as const,
                provider: window.provider,
                accountId: window.accountId,
                accountName: window.accountName,
                windowKind: window.kind,
                windowKey: window.key,
            };

            if (budget) {
                const pace = windowPace({
                    budget,
                    kind: window.kind,
                    utilization: window.utilization,
                    resetsAt: window.resetsAt,
                    samples: samplesOf(round, {
                        provider: window.provider,
                        account: window.accountName,
                        bucket: window.key,
                    }),
                    now: round.now,
                    dayStart,
                    overPaceFactor: settings.overPaceFactor,
                });

                if (pace.status === "over-pace" || pace.status === "under-reserve") {
                    const over = pace.status === "over-pace";
                    candidates.push({
                        ...base,
                        dedupeKey: `budget:${pace.status}:${window.provider}:${window.accountId}:${window.key}`,
                        // A pace belongs to a local day: tomorrow's first breach fires again.
                        cycle: day,
                        severity: paceSeverity(over, pace),
                        level: over ? "warning" : "critical",
                        title: over ? "Over budget pace" : "Into the reserve",
                        message: over
                            ? overPaceMessage(window.accountName, window.label, pace)
                            : `${window.accountName}: ${window.label} at ${Math.round(window.utilization)}%, inside the ${pace.reservePct}% reserve.`,
                        payload: { ...pace },
                    });
                }
            }

            const resetIn = window.resetsAt ? Date.parse(window.resetsAt) - round.now.getTime() : Number.NaN;
            const left = 100 - window.utilization;
            const eligible = budget !== undefined || !settings.useItBudgetedOnly;

            if (
                eligible &&
                window.kind !== "session" &&
                resetIn > 0 &&
                resetIn <= settings.useItHours * HOUR_MS &&
                left >= settings.useItMinLeftPct
            ) {
                candidates.push({
                    ...base,
                    dedupeKey: `budget:use-it:${window.provider}:${window.accountId}:${window.key}`,
                    cycle: window.resetsAt,
                    severity: left,
                    level: "info",
                    title: "Use it or lose it",
                    message: `${window.accountName}: ${window.label} resets in ${Math.round(resetIn / HOUR_MS)} h with ${Math.round(left)}% left.`,
                    payload: { leftPct: left, resetsAt: window.resetsAt },
                });
            }
        }

        return candidates;
    },
    refire: refireOnNewCycleOrHigherSeverity,
};
