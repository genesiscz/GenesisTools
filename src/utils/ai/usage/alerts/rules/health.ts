import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { pollOutcomeOf } from "@genesiscz/utils/ai/usage/poll-runs/store";
import { spendBucketKey } from "@genesiscz/utils/ai/usage/series-keys";
import { ALERT_RULE_DEFAULTS } from "../config";
import { refireOnNewInstant } from "../refire";
import type { AlertCandidate, AlertRound, AlertRuleSettings, UsageAlertRule } from "../types";

const DAY_MS = 86_400_000;

function clock(iso: string): string {
    return new Date(iso).toTimeString().slice(0, 5);
}

/** Where the account's current outcome started: the latest run's start, so one streak alerts once. */
function streakStart(round: AlertRound, snapshot: AccountUsageSnapshot): string {
    const runs = round.runs.filter((run) => run.provider === snapshot.provider && run.accountId === snapshot.accountId);
    return runs.at(-1)?.from ?? snapshot.fetchedAt;
}

function accountCandidate(
    snapshot: AccountUsageSnapshot,
    fields: Pick<AlertCandidate, "cycle" | "level" | "title" | "message"> & {
        what: string;
        payload?: Record<string, unknown>;
    }
): AlertCandidate {
    return {
        rule: "health",
        provider: snapshot.provider,
        accountId: snapshot.accountId,
        accountName: snapshot.accountName,
        windowKind: null,
        windowKey: null,
        dedupeKey: `health:${fields.what}:${snapshot.provider}:${snapshot.accountId}`,
        cycle: fields.cycle,
        severity: fields.level === "critical" ? 2 : 1,
        level: fields.level,
        title: fields.title,
        message: fields.message,
        ...(fields.payload === undefined ? {} : { payload: fields.payload }),
    };
}

function pollerDown(round: AlertRound, settings: AlertRuleSettings["health"]): AlertCandidate[] {
    if (round.previousRoundAt === null) {
        return [];
    }

    const gapMs = round.now.getTime() - Date.parse(round.previousRoundAt);

    if (!(gapMs > settings.downMinutes * 60_000)) {
        return [];
    }

    return [
        {
            rule: "health",
            provider: null,
            accountId: null,
            accountName: null,
            windowKind: null,
            windowKey: null,
            dedupeKey: "health:poller-down",
            cycle: round.previousRoundAt,
            severity: 1,
            level: "warning",
            title: "Usage was not measured",
            message: `The usage poller recorded nothing for ${Math.round(gapMs / 60_000)} min, from ${clock(round.previousRoundAt)} until now.`,
            payload: { from: round.previousRoundAt, to: round.now.toISOString() },
        },
    ];
}

function accountProblems(round: AlertRound, settings: AlertRuleSettings["health"]): AlertCandidate[] {
    const candidates: AlertCandidate[] = [];

    for (const snapshot of round.snapshots) {
        const outcome = pollOutcomeOf(snapshot);

        if (outcome === "backoff" && snapshot.blocked) {
            candidates.push(
                accountCandidate(snapshot, {
                    what: "backoff",
                    cycle: streakStart(round, snapshot),
                    level: "warning",
                    title: "Usage polling paused",
                    message: `${snapshot.accountName}: polling paused until ${clock(snapshot.blocked.until)} after ${snapshot.blocked.failures} failures (${snapshot.error ?? "no reason"}).`,
                    payload: { until: snapshot.blocked.until, failures: snapshot.blocked.failures },
                })
            );
        }

        if (outcome === "blocked") {
            candidates.push(
                accountCandidate(snapshot, {
                    what: "blocked",
                    cycle: streakStart(round, snapshot),
                    level: "critical",
                    title: "Account refused by its organization",
                    message: `${snapshot.accountName}: the provider refuses the account at the organization level (${snapshot.error ?? "403"}).`,
                })
            );
        }

        if (outcome === "needs-login" && snapshot.needsLogin) {
            candidates.push(
                accountCandidate(snapshot, {
                    what: "needs-login",
                    cycle: streakStart(round, snapshot),
                    level: "warning",
                    title: "Account needs a login",
                    message: `${snapshot.accountName}: no credential to poll with. Run: ${snapshot.needsLogin.remedy}`,
                })
            );
        }

        const expires = snapshot.auth?.refreshExpiresAt;
        const expiresMs = expires === undefined ? Number.NaN : Date.parse(expires);
        const leftMs = expiresMs - round.now.getTime();

        if (expires !== undefined && leftMs > 0 && leftMs <= settings.refreshExpiryDays * DAY_MS) {
            candidates.push(
                accountCandidate(snapshot, {
                    what: "refresh-expiry",
                    cycle: expires,
                    level: "warning",
                    title: "A login runs out soon",
                    message: `${snapshot.accountName}: its refresh grant expires in ${Math.ceil(leftMs / DAY_MS)} days (${new Date(expires).toDateString()}).`,
                    payload: { refreshExpiresAt: expires },
                })
            );
        }
    }

    return candidates;
}

/** A refused quota probe means the budget is spent: the account's readings stop until the budget rolls over. */
function probesRefused(round: AlertRound): AlertCandidate[] {
    const since = round.previousRoundAt ?? new Date(round.now.getTime() - 60 * 60_000).toISOString();
    const seen = new Set<string>();
    const candidates: AlertCandidate[] = [];

    for (const event of round.events) {
        if (event.kind !== "probe-refused" || event.ts <= since) {
            continue;
        }

        const key = `health:probe-budget:${event.provider}:${event.accountName ?? ""}:${event.model ?? ""}`;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        candidates.push({
            rule: "health",
            provider: event.provider,
            accountId: event.accountId,
            accountName: event.accountName,
            windowKind: null,
            windowKey: null,
            dedupeKey: key,
            cycle: spendBucketKey(event.ts, "day"),
            severity: 1,
            level: "warning",
            title: "Quota probe budget spent",
            message: `${event.accountName ?? event.provider}: ${event.detail ?? "the quota probe budget is spent"} (${event.model ?? "probe"}).`,
        });
    }

    return candidates;
}

/**
 * Proposal 8's watchdog: the poller missed a span (the daemon was down or the Mac slept), an account is held back by
 * the poll gate, refused by its organization, has no credential, or its refresh grant runs out soon, or the probe
 * budget refused a probe. Each streak alerts once: its cycle is the streak's start.
 */
export const healthRule: UsageAlertRule<"health"> = {
    id: "health",
    description:
        "The poller missed a span, an account is paused, refused or logged out, a login expires, or probes ran out",
    defaults: ALERT_RULE_DEFAULTS.health,
    evaluate(round, settings: AlertRuleSettings["health"]) {
        return [...pollerDown(round, settings), ...accountProblems(round, settings), ...probesRefused(round)];
    },
    refire: refireOnNewInstant,
};
