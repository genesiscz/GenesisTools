import type { AccountKey, UsageWarning } from "@genesiscz/utils/ai/usage/contract/envelope";
import { DAEMON_ALIVE_MS, DAEMON_TICK_MS } from "@genesiscz/utils/ai/usage-poll/daemon-heartbeat";
import { aiUsageCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { type PollOutcome, type PollRun, RUN_CONTINUES_MS } from "./store";

/** `usage.limits.health@1`: the verb and its shape version. */
export const LIMITS_HEALTH_SCHEMA = { verb: "limits.health", version: 1 } as const;

/** A span the window names with no poll in it shorter than this is one late tick, not a gap. */
export const MIN_GAP_MS = 5 * 60_000;

/** Polled fine for this long with no usage change: the account is idle, not broken and not unmeasured. */
export const IDLE_AFTER_MS = 30 * 60_000;

export interface HealthSpan {
    /** ISO UTC. */
    from: string;
    to: string;
    minutes: number;
}

export interface HealthRun {
    from: string;
    to: string;
    outcome: PollOutcome;
    source: string | null;
    polls: number;
}

export interface AccountHealth extends AccountKey {
    /** The latest run's outcome, or `unmeasured` when no run reaches the present. */
    outcome: PollOutcome | "unmeasured";
    /** When the current outcome started. */
    since: string | null;
    /** The last poll of this account, at any outcome. */
    lastPollAt: string | null;
    source: string | null;
    gateUntil: string | null;
    reason: string | null;
    /** Share of the window some poll measured, 0 to 100. */
    coveragePct: number;
    /** Spans of at least `MIN_GAP_MS` with no poll, oldest first. */
    gaps: HealthSpan[];
    /**
     * For an account polled `ok` now: `idle` when it was polled fine for the last `IDLE_AFTER_MS` and its usage did
     * not change in that time, `active` when its usage changed within it. Null when it is not polled fine now, or
     * was polled fine too briefly to tell.
     */
    activity: "active" | "idle" | null;
    /** The newest stored reading, which the poller writes only on a change; null without one. */
    lastChangeAt: string | null;
    /** Every run that overlaps the window, oldest first (the strip under the burn lanes). */
    runs: HealthRun[];
}

export interface LimitsHealthData {
    daemon: {
        /** Age of the daemon's heartbeat file, or null without one. */
        heartbeatAgeMs: number | null;
        alive: boolean;
        /** The newest poll round any process recorded. */
        lastRoundAt: string | null;
    };
    accounts: AccountHealth[];
}

export interface LimitsHealthInput {
    accounts: readonly AccountKey[];
    runs: readonly PollRun[];
    /** Each account's newest run at any time (`PollRunsStore.latestRuns`): the NOW columns, whatever the window. */
    latest: readonly PollRun[];
    window: { from: Date; to: Date };
    now: Date;
    heartbeatAgeMs: number | null;
    lastRoundAt: string | null;
    /** When each account's usage last changed (`lastReadingChanges`), keyed `<provider>\0<account name>`. */
    lastChanges: ReadonlyMap<string, string>;
}

interface Interval {
    from: number;
    to: number;
}

/** A run covers its polls plus one tick after the last one: the next poll was not due before that. */
function covered(runs: readonly PollRun[], window: Interval): Interval[] {
    const spans = runs
        .map((run) => ({
            from: Math.max(Date.parse(run.from), window.from),
            to: Math.min(Date.parse(run.to) + DAEMON_TICK_MS, window.to),
        }))
        .filter((span) => span.to > span.from)
        .sort((left, right) => left.from - right.from);
    const merged: Interval[] = [];

    for (const span of spans) {
        const last = merged.at(-1);

        if (last && span.from <= last.to) {
            last.to = Math.max(last.to, span.to);
            continue;
        }

        merged.push({ ...span });
    }

    return merged;
}

function gapsOf(spans: readonly Interval[], window: Interval): HealthSpan[] {
    const gaps: HealthSpan[] = [];
    let cursor = window.from;

    for (const span of [...spans, { from: window.to, to: window.to }]) {
        if (span.from - cursor >= MIN_GAP_MS) {
            gaps.push({
                from: new Date(cursor).toISOString(),
                to: new Date(span.from).toISOString(),
                minutes: Math.round((span.from - cursor) / 60_000),
            });
        }

        cursor = Math.max(cursor, span.to);
    }

    return gaps;
}

function activityOf(input: {
    outcome: PollOutcome | "unmeasured";
    since: string | null;
    lastChangeAt: string | null;
    now: Date;
}): AccountHealth["activity"] {
    if (input.outcome !== "ok" || input.since === null) {
        return null;
    }

    const quietFrom = input.now.getTime() - IDLE_AFTER_MS;

    if (input.lastChangeAt !== null && Date.parse(input.lastChangeAt) > quietFrom) {
        return "active";
    }

    return Date.parse(input.since) <= quietFrom ? "idle" : null;
}

function accountHealth(
    account: AccountKey,
    input: Pick<LimitsHealthInput, "runs" | "latest" | "now" | "lastChanges">,
    window: Interval
): AccountHealth {
    const mine = (run: PollRun) => run.provider === account.provider && run.accountId === account.accountId;
    const own = input.runs.filter(mine);
    const spans = covered(own, window);
    const measuredMs = spans.reduce((sum, span) => sum + (span.to - span.from), 0);
    const windowMs = Math.max(1, window.to - window.from);
    // The current state comes from the account's newest run, not the window's: a past window still says what is now.
    const now = input.now;
    const latest = input.latest.find(mine);
    const current = latest !== undefined && now.getTime() - Date.parse(latest.to) <= RUN_CONTINUES_MS;
    const outcome = current ? latest.outcome : "unmeasured";
    const since = current ? latest.from : (latest?.to ?? null);
    const lastChangeAt = input.lastChanges.get(`${account.provider}\u0000${account.accountName}`) ?? null;

    return {
        ...account,
        outcome,
        since,
        lastPollAt: latest?.to ?? null,
        source: latest?.source ?? null,
        gateUntil: current ? latest.gateUntil : null,
        reason: latest?.reason ?? null,
        coveragePct: Math.round((measuredMs / windowMs) * 1000) / 10,
        gaps: gapsOf(spans, window),
        activity: activityOf({ outcome, since, lastChangeAt, now }),
        lastChangeAt,
        runs: own.map((run) => ({
            from: run.from,
            to: run.to,
            outcome: run.outcome,
            source: run.source,
            polls: run.polls,
        })),
    };
}

/**
 * `tools ai usage limits health` (design 2026-11-01, step U5): per account, what the poller knew over the window, so
 * a flat line reads as idle, unmeasured, stale or held back. Pure: the door reads the runs, the accounts and the
 * heartbeat, and nothing here touches a store.
 */
export function limitsHealth(input: LimitsHealthInput): { data: LimitsHealthData; warnings: UsageWarning[] } {
    const window = { from: input.window.from.getTime(), to: Math.min(input.window.to.getTime(), input.now.getTime()) };
    const alive = input.heartbeatAgeMs !== null && input.heartbeatAgeMs <= DAEMON_ALIVE_MS;
    const warnings: UsageWarning[] = [];

    if (!alive) {
        warnings.push({
            code: "daemon-down",
            message:
                input.heartbeatAgeMs === null
                    ? `The usage daemon has never run here. Run ${aiUsageCommand("daemon", "register")}.`
                    : `The usage daemon last ran ${Math.round(input.heartbeatAgeMs / 60_000)} min ago. Check ${aiUsageCommand("daemon", "status")}.`,
        });
    }

    if (input.lastRoundAt === null) {
        warnings.push({
            code: "no-runs",
            message: "No poll round has been recorded yet: coverage starts with the first daemon tick of this build.",
        });
    }

    return {
        data: {
            daemon: { heartbeatAgeMs: input.heartbeatAgeMs, alive, lastRoundAt: input.lastRoundAt },
            accounts: input.accounts.map((account) => accountHealth(account, input, window)),
        },
        warnings,
    };
}
