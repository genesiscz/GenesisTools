import { RATE_LIMIT_EVENT_KINDS, type UsageEventRow } from "@genesiscz/utils/ai/usage/events/store";
import { ALERT_RULE_DEFAULTS } from "../config";
import type { AlertCandidate, AlertRuleSettings, UsageAlertRule } from "../types";

function accountOf(event: UsageEventRow): string {
    return event.accountId ?? event.accountName ?? "";
}

/**
 * Proposal 15 as an alert: an account got `count` rate-limit answers (the usage endpoint's or the proxy's) within
 * `windowMinutes`. The card names the cooldown the proxy took, when it took one. The same account alerts again once
 * the window has passed, or sooner when the count doubles.
 */
export const rateLimitedRule: UsageAlertRule<"rate-limited"> = {
    id: "rate-limited",
    description: "An account got several rate-limit answers within a few minutes",
    defaults: ALERT_RULE_DEFAULTS["rate-limited"],
    evaluate(round, settings: AlertRuleSettings["rate-limited"]) {
        const since = new Date(round.now.getTime() - settings.windowMinutes * 60_000).toISOString();
        const recent = round.events.filter((event) => event.ts >= since);
        const groups = new Map<string, UsageEventRow[]>();

        for (const event of recent) {
            if (!RATE_LIMIT_EVENT_KINDS.includes(event.kind)) {
                continue;
            }

            const key = `${event.provider}\u0000${accountOf(event)}`;
            groups.set(key, [...(groups.get(key) ?? []), event]);
        }

        const candidates: AlertCandidate[] = [];

        for (const events of groups.values()) {
            const count = events.reduce((sum, event) => sum + event.count, 0);

            if (count < settings.count) {
                continue;
            }

            const first = events[0];
            const name = first.accountName ?? first.accountId ?? first.provider;
            const sources = [...new Set(events.map((event) => event.source))].join(", ");
            const cooldown = recent.find(
                (event) =>
                    event.kind === "cooldown" &&
                    event.provider === first.provider &&
                    accountOf(event) === accountOf(first) &&
                    event.retryAfterMs !== null
            );
            const cools = cooldown?.retryAfterMs
                ? ` It cools down for ${Math.round(cooldown.retryAfterMs / 1000)} s.`
                : "";

            candidates.push({
                rule: "rate-limited",
                provider: first.provider,
                accountId: first.accountId,
                accountName: first.accountName,
                windowKind: null,
                windowKey: null,
                dedupeKey: `rate-limited:${first.provider}:${accountOf(first)}`,
                cycle: null,
                severity: count,
                level: "warning",
                title: "Rate limited",
                message: `${name} got ${count} rate-limit answers in ${settings.windowMinutes} min (${sources}).${cools}`,
                payload: { count, windowMinutes: settings.windowMinutes, sources },
            });
        }

        return candidates;
    },
    refire(previous, next, now) {
        const windowMinutes = Number(next.payload?.windowMinutes ?? 10);
        const quietMs = windowMinutes * 60_000;
        // Each new answer raises the count, so "higher" alone would alert every round of a burst; double is news.
        return now.getTime() - Date.parse(previous.firedAt) >= quietMs || next.severity >= previous.severity * 2;
    },
};
