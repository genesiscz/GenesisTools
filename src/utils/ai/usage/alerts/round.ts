import type { Database } from "bun:sqlite";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { UsageEventsStore } from "@genesiscz/utils/ai/usage/events/store";
import { readUsageSamples } from "@genesiscz/utils/ai/usage/forecast/samples";
import { PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import type { AlertRound, AvailabilityChange } from "./types";

const HOUR_MS = 3_600_000;
/** The forecast lookback of one tick: three days keeps the read inside the daemon's 50 s budget (proposal 7). */
export const ALERT_SAMPLE_LOOKBACK_MS = 72 * HOUR_MS;
const RUN_LOOKBACK_MS = 24 * HOUR_MS;
const EVENT_LOOKBACK_MS = HOUR_MS;
/** With no earlier round, availability changes of the last five minutes count as this round's. */
const FIRST_ROUND_SINCE_MS = 5 * 60_000;

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
}): AlertRound {
    const { db, now } = input;
    const nowMs = now.getTime();
    let samples: AlertRound["samples"] = [];

    try {
        samples = readUsageSamples(db, { since: new Date(nowMs - ALERT_SAMPLE_LOOKBACK_MS) });
    } catch (err) {
        if (!isMissing(err)) {
            throw err;
        }
    }

    const since = input.previousRoundAt ? new Date(input.previousRoundAt) : new Date(nowMs - FIRST_ROUND_SINCE_MS);

    return {
        now,
        snapshots: input.snapshots,
        samples,
        runs: new PollRunsStore(db).runsBetween({ from: new Date(nowMs - RUN_LOOKBACK_MS), to: now }),
        previousRoundAt: input.previousRoundAt,
        events: new UsageEventsStore(db).list({ from: new Date(nowMs - EVENT_LOOKBACK_MS), to: now }).reverse(),
        availabilityChanges: availabilityChangesSince(db, since),
    };
}
