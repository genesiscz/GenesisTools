import { formatDuration as formatDurationShared } from "@genesiscz/utils/format";
import type { UsageHistoryDb } from "./history-db";
import { calculateRollingRates, projectTimeToLimit, type RollingRates, type TimestampedValue } from "./rate-math";

/**
 * "≈35m at pace" — how long a bucket lasts at the OBSERVED burn rate.
 *
 * Two rates, in order of preference:
 *  1. ACTIVE burn — median of positive per-sample deltas, discarding gaps longer
 *     than ACTIVE_MAX_GAP_MIN so idle stretches don't dilute the number. This is
 *     the honest "at the pace you actually work" figure.
 *  2. Rolling-window average — the fallback when there aren't enough active
 *     samples yet; includes idle time, so it reads optimistic.
 *
 * Neither attributes usage to a PERSON: the API reports account-level buckets
 * with no actor field, so anyone else signed into the same account burns what
 * looks like "your" pace. Only the account's total consumption is knowable.
 */

/** How far back to read samples. */
const LOOKBACK_MINUTES = 3 * 24 * 60;
/** A gap longer than this is an idle stretch, not a burn sample. */
const ACTIVE_MAX_GAP_MIN = 45;
/** Utilization is reported in whole-ish percents; ignore sub-noise deltas. */
const MIN_DELTA_PCT = 0.05;
/** Below this many active samples the median is noise — fall back to rolling. */
const MIN_ACTIVE_SAMPLES = 3;

export type PaceScope = "pooled" | "per-account";
export type PaceBasis = "active" | "rolling";

export interface PaceResult {
    label: string;
    /** Which rate produced it — `rolling` is the weaker, idle-diluted fallback. */
    basis: PaceBasis;
    minutes: number;
}

function median(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Positive per-sample deltas as %/min, gaps over ACTIVE_MAX_GAP_MIN dropped.
 * A NEGATIVE delta means a reset rolled through — never a burn sample.
 * Exported for tests and for pooling across accounts.
 */
export function activeDeltas(samples: TimestampedValue[]): number[] {
    const sorted = [...samples].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const rates: number[] = [];

    for (let i = 1; i < sorted.length; i++) {
        const prevMs = new Date(sorted[i - 1].timestamp).getTime();
        const curMs = new Date(sorted[i].timestamp).getTime();
        const gapMinutes = (curMs - prevMs) / 60_000;

        if (!Number.isFinite(gapMinutes) || gapMinutes <= 0 || gapMinutes > ACTIVE_MAX_GAP_MIN) {
            continue;
        }

        const delta = sorted[i].value - sorted[i - 1].value;

        if (delta > MIN_DELTA_PCT) {
            rates.push(delta / gapMinutes);
        }
    }

    return rates;
}

/** Widest rolling window with data wins — smooths noise better than a short one. */
function bestRollingRate(rates: RollingRates): number | null {
    return rates["30min"] ?? rates["10min"] ?? rates["5min"] ?? rates["1min"] ?? null;
}

export interface RateChoice {
    ratePctPerMinute: number;
    basis: PaceBasis;
}

/**
 * Active-burn median when there is enough of it, rolling average otherwise.
 * `deltas` may come from one account or be pooled across several.
 */
export function chooseRate(deltas: number[], samples: TimestampedValue[], now: Date): RateChoice | null {
    if (deltas.length >= MIN_ACTIVE_SAMPLES) {
        const active = median(deltas);

        if (active !== undefined && active > 0) {
            return { ratePctPerMinute: active, basis: "active" };
        }
    }

    const rolling = bestRollingRate(calculateRollingRates(samples, now));

    if (rolling !== null && rolling > 0) {
        return { ratePctPerMinute: rolling, basis: "rolling" };
    }

    return null;
}

/** "≈35m", "≈2h 10m". */
export function paceLabel(minutes: number): string {
    return `≈${formatDurationShared(minutes, "min", "hm-smart")}`;
}

export interface PaceInput {
    accountName: string;
    /** `five_hour` / `seven_day` / `seven_day_<model>` — matches what `recordAll` writes. */
    bucket: string;
    /** Current utilization, 0-100 (percent USED, matching `usage_snapshots.utilization`). */
    utilizationPct: number;
    /**
     * `pooled` (default) mirrors switcheroo: your typical pace across every
     * account, which survives an account with little history of its own.
     * `per-account` answers "when does THIS account run out" more precisely.
     */
    scope?: PaceScope;
}

function samplesFor(db: UsageHistoryDb, accountName: string, bucket: string): TimestampedValue[] {
    return db
        .getSnapshots(accountName, bucket, LOOKBACK_MINUTES)
        .map((s) => ({ timestamp: s.timestamp, value: s.utilization }));
}

/**
 * `db` is injected so callers reuse the process-wide connection (see
 * `shared-cache.ts recordAll`'s note on why a second connection must not be
 * opened mid-flight) instead of each call spinning up its own.
 */
export function paceFor(db: UsageHistoryDb, input: PaceInput, now: Date = new Date()): PaceResult | undefined {
    const scope = input.scope ?? "pooled";
    const own = samplesFor(db, input.accountName, input.bucket);

    let deltas = activeDeltas(own);

    if (scope === "pooled") {
        // Same bucket kind across every account we have history for — one
        // person's working rhythm, not one account's.
        for (const entry of db.getAllAccountBuckets()) {
            if (entry.bucket !== input.bucket || entry.accountName === input.accountName) {
                continue;
            }

            deltas = deltas.concat(activeDeltas(samplesFor(db, entry.accountName, entry.bucket)));
        }
    }

    const choice = chooseRate(deltas, own, now);

    if (!choice) {
        return undefined;
    }

    const minutes = projectTimeToLimit(input.utilizationPct, choice.ratePctPerMinute);

    if (minutes === null) {
        return undefined;
    }

    return { label: paceLabel(minutes), basis: choice.basis, minutes };
}

/** Convenience for callers that only want the string. */
export function atYourPace(db: UsageHistoryDb, input: PaceInput, now: Date = new Date()): string | undefined {
    return paceFor(db, input, now)?.label;
}
