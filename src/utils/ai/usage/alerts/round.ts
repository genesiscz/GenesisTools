import type { Database } from "bun:sqlite";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import type { UsageBudgets } from "@genesiscz/utils/ai/usage/budgets/budgets";
import { UsageEventsStore } from "@genesiscz/utils/ai/usage/events/store";
import { readSampleSeeds, readUsageSamples } from "@genesiscz/utils/ai/usage/forecast/samples";
import { PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import type { UsageAlertsConfig } from "./config";
import type { AlertRound, AvailabilityChange } from "./types";

const HOUR_MS = 3_600_000;
/** The forecast lookback of one tick: three days keeps the read inside the daemon's 50 s budget (proposal 7). */
export const ALERT_SAMPLE_LOOKBACK_MS = 72 * HOUR_MS;
const RUN_LOOKBACK_MS = 24 * HOUR_MS;
const EVENT_LOOKBACK_MS = HOUR_MS;

/**
 * How far back a round catches up on events after failed passes: the 30 days the usage tables keep by default. A
 * cursor older than that has nothing left to read past it.
 */
export const ALERT_EVENT_CATCH_UP_MS = 30 * 24 * HOUR_MS;

/** The events a round reads: the last hour, or the rate-limited rule's window when it is longer. */
export function alertEventLookbackMs(config: UsageAlertsConfig): number {
    return Math.max(EVENT_LOOKBACK_MS, config.rules["rate-limited"].windowMinutes * 60_000);
}

/**
 * Where a round starts reading events: the earlier of the rolling lookback and the alert cursor, so the events of
 * passes that failed for longer than the lookback still reach the pass that catches up. The catch-up stops at
 * `ALERT_EVENT_CATCH_UP_MS`. A rule with a time window of its own (rate-limited) still filters by it.
 */
export function alertEventsFrom(input: { now: Date; lastEvaluatedAt: string | null; config: UsageAlertsConfig }): Date {
    const nowMs = input.now.getTime();
    const lookback = nowMs - alertEventLookbackMs(input.config);
    const cursor = input.lastEvaluatedAt === null ? Number.NaN : Date.parse(input.lastEvaluatedAt);

    if (!Number.isFinite(cursor) || cursor >= lookback) {
        return new Date(lookback);
    }

    return new Date(Math.max(cursor, nowMs - ALERT_EVENT_CATCH_UP_MS));
}
/** With no earlier round, availability changes of the last five minutes count as this round's. */
export const FIRST_ROUND_SINCE_MS = 5 * 60_000;

interface AvailabilitySqlRow {
    provider: string;
    account_id: string | null;
    account_name: string;
    bucket: string;
    kind: string | null;
    timestamp: string;
    availability: string;
    previous: string | null;
}

function isMissing(err: unknown): boolean {
    return err instanceof Error && /no such (table|column)/.test(err.message);
}

function isState(value: string | null): value is "limited" | "absent" {
    return value === "limited" || value === "absent";
}

/**
 * Windows whose stored availability changed since `since`: each row with a state, beside the row before it in the
 * same series. A row from before the availability column (NULL, `unknown`) is no evidence of a change.
 */
export function availabilityChangesSince(db: Database, since: Date): AvailabilityChange[] {
    try {
        const rows = db
            .prepare(
                `SELECT s.provider, s.account_id, s.account_name, s.bucket, s.kind, s.timestamp, s.availability,
                        (SELECT p.availability FROM usage_snapshots p
                          WHERE p.provider = s.provider AND p.account_name = s.account_name AND p.bucket = s.bucket
                            AND (p.timestamp < s.timestamp OR (p.timestamp = s.timestamp AND p.id < s.id))
                          ORDER BY p.timestamp DESC, p.id DESC LIMIT 1) AS previous
                 FROM usage_snapshots s
                 WHERE s.timestamp > ? AND s.availability IS NOT NULL
                 ORDER BY s.timestamp ASC, s.id ASC`
            )
            .all(since.toISOString()) as AvailabilitySqlRow[];

        return rows.flatMap((row) => {
            if (!isState(row.availability) || !isState(row.previous) || row.availability === row.previous) {
                return [];
            }

            return [
                {
                    provider: row.provider,
                    accountId: row.account_id,
                    accountName: row.account_name,
                    bucket: row.bucket,
                    kind: row.kind,
                    at: row.timestamp,
                    from: row.previous,
                    to: row.availability,
                },
            ];
        });
    } catch (err) {
        if (isMissing(err)) {
            return [];
        }

        throw err;
    }
}

/**
 * Everything the rules read about one round, read once. `previousRoundAt` must be taken BEFORE this round's poll runs
 * are recorded, or the poller-down check compares the round with itself. Works on a read-only connection, which is
 * what `tools ai usage alerts test` passes.
 */
export function buildAlertRound(input: {
    db: Database;
    snapshots: readonly AccountUsageSnapshot[];
    now: Date;
    previousRoundAt: string | null;
    /** The end of the last finished alert pass (`UsageAlertsStore.lastEvaluatedAt`); omitted is none. */
    lastEvaluatedAt?: string | null;
    /** The alerts config the round is judged by: its rules decide how far back the events are read. */
    config: UsageAlertsConfig;
    /** The usage config's budgets; required, so a caller cannot silently judge none. */
    budgets: UsageBudgets;
}): AlertRound {
    const { db, now } = input;
    const nowMs = now.getTime();
    let samples: AlertRound["samples"] = [];
    let baselines: AlertRound["baselines"] = [];

    try {
        samples = readUsageSamples(db, { since: new Date(nowMs - ALERT_SAMPLE_LOOKBACK_MS) });
        baselines = readSampleSeeds(db, { before: new Date(nowMs - ALERT_SAMPLE_LOOKBACK_MS) });
    } catch (err) {
        if (!isMissing(err)) {
            throw err;
        }
    }

    const lastEvaluatedAt = input.lastEvaluatedAt ?? null;
    const sinceAt = lastEvaluatedAt ?? input.previousRoundAt;
    const since = sinceAt ? new Date(sinceAt) : new Date(nowMs - FIRST_ROUND_SINCE_MS);

    return {
        now,
        snapshots: input.snapshots,
        samples,
        runs: new PollRunsStore(db).runsBetween({ from: new Date(nowMs - RUN_LOOKBACK_MS), to: now }),
        previousRoundAt: input.previousRoundAt,
        lastEvaluatedAt,
        events: new UsageEventsStore(db)
            .list({ from: alertEventsFrom({ now, lastEvaluatedAt, config: input.config }), to: now })
            .reverse(),
        availabilityChanges: availabilityChangesSince(db, since),
        baselines,
        budgets: input.budgets,
    };
}
