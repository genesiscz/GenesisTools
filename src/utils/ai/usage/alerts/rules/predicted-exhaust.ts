import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import {
    type AbsentWindows,
    absentKey,
    forecastClock,
    forecastFromSamples,
    type WindowForecast,
} from "@genesiscz/utils/ai/usage/forecast/forecast";
import type { UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import { isObject } from "@genesiscz/utils/object";
import { ALERT_RULE_DEFAULTS } from "../config";
import { sameResetCycle } from "../refire";
import type { AlertCandidate, AlertRound, AlertRuleSettings, UsageAlertRule } from "../types";

/** The run-out time has to move at least this much earlier before the same cycle alerts again. */
const EARLIER_BY_MS = 30 * 60_000;

function absentOf(snapshots: readonly AccountUsageSnapshot[]): AbsentWindows {
    return new Map(
        snapshots.map((snapshot) => [
            absentKey(snapshot.provider, snapshot.accountName),
            (snapshot.absentLimits ?? []).map((limit) => limit.key),
        ])
    );
}

/** The window's use rose within the last `minutes`: someone is working on the account now. */
function risingWithin(samples: readonly UsageSample[], now: Date, minutes: number): boolean {
    const since = now.getTime() - minutes * 60_000;

    for (let i = 1; i < samples.length; i++) {
        if (Date.parse(samples[i].timestamp) >= since && samples[i].utilization > samples[i - 1].utilization) {
            return true;
        }
    }

    return false;
}

function samplesOf(round: AlertRound, provider: string, account: string, bucket: string): UsageSample[] {
    return round.samples
        .filter((sample) => sample.provider === provider && sample.account === account && sample.bucket === bucket)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function message(account: string, window: WindowForecast, now: Date): string {
    const exhaust = window.exhaustAt ? forecastClock(new Date(window.exhaustAt), now) : "?";
    const reset = window.resetsAt ? forecastClock(new Date(window.resetsAt), now) : "?";
    const pace = window.basis === "active" ? "active pace" : `${window.basis ?? "window"} pace`;
    return `${account}: ${window.label} ${Math.round(window.utilization)}%, at limit ${exhaust}, resets ${reset} (${window.ratePctPerHour}%/h, ${pace}).`;
}

/**
 * The first new rule of proposal 7: after each round the forecast runs for every window, and the rule fires when a
 * window runs out before its reset within the lead time of its kind. Stale and absent windows are skipped. By
 * default only a window whose use rose in the last half hour counts, so an idle account never alerts.
 */
export const predictedExhaustRule: UsageAlertRule<"predicted-exhaust"> = {
    id: "predicted-exhaust",
    description: "The forecast runs a window out before its reset, within the lead time of its kind",
    defaults: ALERT_RULE_DEFAULTS["predicted-exhaust"],
    evaluate(round, settings: AlertRuleSettings["predicted-exhaust"]) {
        const fresh = round.snapshots.filter((snapshot) => !snapshot.stale && snapshot.error === undefined);
        const byAccount = new Map(
            fresh.map((snapshot) => [absentKey(snapshot.provider, snapshot.accountName), snapshot])
        );
        const forecasts = forecastFromSamples(round.samples, { now: round.now, absent: absentOf(fresh) });
        const candidates: AlertCandidate[] = [];

        for (const account of forecasts) {
            const snapshot = byAccount.get(absentKey(account.provider, account.account));

            if (!snapshot) {
                continue;
            }

            for (const window of account.windows) {
                const lead = settings.leadMinutes[window.kind];

                if (
                    window.stale ||
                    window.resetSinceSample ||
                    !window.beforeReset ||
                    window.exhaustAt === null ||
                    window.minutesToExhaust === null ||
                    window.minutesToExhaust > lead
                ) {
                    continue;
                }

                if (
                    settings.requireActive &&
                    !risingWithin(
                        samplesOf(round, account.provider, account.account, window.bucket),
                        round.now,
                        settings.activeMinutes
                    )
                ) {
                    continue;
                }

                candidates.push({
                    rule: "predicted-exhaust",
                    provider: account.provider,
                    accountId: snapshot.accountId,
                    accountName: account.account,
                    windowKind: window.kind,
                    windowKey: window.bucket,
                    dedupeKey: `predicted-exhaust:${account.provider}:${snapshot.accountId}:${window.bucket}`,
                    cycle: window.resetsAt,
                    severity: window.utilization,
                    level: window.minutesToExhaust <= lead / 2 ? "critical" : "warning",
                    title: "Usage runs out before the reset",
                    message: message(account.account, window, round.now),
                    payload: {
                        exhaustAt: window.exhaustAt,
                        resetsAt: window.resetsAt,
                        minutesToExhaust: window.minutesToExhaust,
                        ratePctPerHour: window.ratePctPerHour,
                        basis: window.basis,
                    },
                });
            }
        }

        return candidates;
    },
    /** A new reset re-arms it; in the same cycle only a run-out at least 30 minutes earlier than the last alert's. */
    refire(previous, next) {
        if (!sameResetCycle(previous.cycle, next.cycle)) {
            return true;
        }

        const before = isObject(previous.payload) ? Date.parse(String(previous.payload.exhaustAt)) : Number.NaN;
        const after = isObject(next.payload) ? Date.parse(String(next.payload.exhaustAt)) : Number.NaN;

        return Number.isFinite(before) && Number.isFinite(after) && before - after >= EARLIER_BY_MS;
    },
};
