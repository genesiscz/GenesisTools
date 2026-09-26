import type { Database } from "bun:sqlite";
import { activeDeltas, chooseRate } from "@app/claude/lib/usage/burn-pace";
import { projectTimeToLimit, type TimestampedValue } from "@app/claude/lib/usage/rate-math";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import { logger } from "@genesiscz/utils/logger";

// `tools hub forecast`: when each account's current 5-hour and weekly windows run out at the recent
// burn rate. It only READS `usage_snapshots` (what the usage poller already recorded) through a
// read-only handle: no API fetch, no schema write (`UsageLimitsDb` runs CREATE/ALTER on open).

const log = logger.child({ component: "hub/forecast" });

export type ForecastWindowKind = "session" | "weekly" | "scoped";
export type ForecastBasis = "active" | "rolling" | "window";

export interface UsageSample {
    provider: string;
    account: string;
    bucket: string;
    kind: string | null;
    utilization: number;
    resetsAt: string | null;
    timestamp: string;
}

export interface WindowForecast {
    bucket: string;
    kind: ForecastWindowKind;
    label: string;
    /** Percent used at the last sample. */
    utilization: number;
    resetsAt: string | null;
    lastSampleAt: string;
    samples: number;
    /** Percent per hour; null when the samples show no burn. */
    ratePctPerHour: number | null;
    basis: ForecastBasis | null;
    /** When 100 % is reached at that rate; null without a rate. */
    exhaustAt: string | null;
    minutesToExhaust: number | null;
    /** The window runs out before it resets: the hub colours this as a warning. */
    beforeReset: boolean;
    /** Percent used at the reset if the rate holds (may exceed 100). */
    projectedAtReset: number | null;
    /** The reset time already passed after the last sample: the window restarted, nothing to forecast. */
    resetSinceSample: boolean;
    /** The last sample is older than the window's freshness limit. */
    stale: boolean;
}

export interface AccountForecast {
    provider: string;
    account: string;
    windows: WindowForecast[];
    /** The earliest window that runs out before its reset, if any. */
    warning: string | null;
}

export interface ForecastResult {
    generatedAt: string;
    source: string | null;
    accounts: AccountForecast[];
    elapsedMs: number;
}

const HOUR = 3_600_000;
const PERIOD_MS: Record<ForecastWindowKind, number> = {
    session: 5 * HOUR,
    weekly: 7 * 24 * HOUR,
    scoped: 7 * 24 * HOUR,
};
const STALE_MS: Record<ForecastWindowKind, number> = { session: 30 * 60_000, weekly: 6 * HOUR, scoped: 6 * HOUR };
export const FORECAST_LOOKBACK_MS = 8 * 24 * HOUR;

export function windowKind(sample: Pick<UsageSample, "kind" | "bucket">): ForecastWindowKind {
    if (sample.kind === "session" || sample.bucket === "five_hour") {
        return "session";
    }

    if (sample.kind === "weekly" || sample.bucket === "seven_day" || sample.bucket === "weekly") {
        return "weekly";
    }

    return "scoped";
}

export function windowLabel(bucket: string, kind: ForecastWindowKind): string {
    if (kind === "session") {
        return "5h";
    }

    if (kind === "weekly") {
        return "Weekly";
    }

    const scope = bucket.replace(/^seven_day_/, "7d ").replace(/^product:/, "");
    return scope;
}

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

/**
 * One window's forecast from its samples (oldest first, one provider/account/bucket).
 * 5h windows use the active burn (median of per-sample rises, idle gaps dropped, `burn-pace.ts`),
 * because a 5-hour window is spent while working. Weekly windows use the window's own average since
 * it started (idle nights included), because a week is not worked around the clock.
 */
export function forecastWindow(samples: readonly UsageSample[], now: Date = new Date()): WindowForecast | null {
    if (samples.length === 0) {
        return null;
    }

    const last = samples[samples.length - 1];
    const kind = windowKind(last);
    const nowMs = now.getTime();
    const lastMs = Date.parse(last.timestamp);
    const resetMs = last.resetsAt ? Date.parse(last.resetsAt) : Number.NaN;
    const hasReset = Number.isFinite(resetMs);
    const resetSinceSample = hasReset && resetMs <= nowMs;
    const base: WindowForecast = {
        bucket: last.bucket,
        kind,
        label: windowLabel(last.bucket, kind),
        utilization: last.utilization,
        resetsAt: last.resetsAt,
        lastSampleAt: last.timestamp,
        samples: samples.length,
        ratePctPerHour: null,
        basis: null,
        exhaustAt: null,
        minutesToExhaust: null,
        beforeReset: false,
        projectedAtReset: null,
        resetSinceSample,
        stale: nowMs - lastMs > STALE_MS[kind],
    };

    if (resetSinceSample) {
        return base;
    }

    // Only samples of the current window: a rise across a reset is not a burn.
    const windowStart = hasReset ? resetMs - PERIOD_MS[kind] : nowMs - PERIOD_MS[kind];
    const current = samples.filter((sample) => Date.parse(sample.timestamp) >= windowStart);
    const values: TimestampedValue[] = current.map((sample) => ({
        timestamp: sample.timestamp,
        value: sample.utilization,
    }));
    let ratePerMinute: number | null = null;
    let basis: ForecastBasis | null = null;

    if (kind === "session") {
        const choice = chooseRate(activeDeltas(values), values, now);

        if (choice) {
            ratePerMinute = choice.ratePctPerMinute;
            basis = choice.basis;
        }
    } else {
        const elapsedMin = (lastMs - windowStart) / 60_000;

        if (hasReset && elapsedMin > 30 && last.utilization > 0) {
            ratePerMinute = last.utilization / elapsedMin;
            basis = "window";
        } else if (values.length >= 2) {
            const first = values[0];
            const spanMin = (lastMs - Date.parse(first.timestamp)) / 60_000;
            const rise = last.utilization - first.value;

            if (spanMin > 30 && rise > 0) {
                ratePerMinute = rise / spanMin;
                basis = "window";
            }
        }
    }

    if (ratePerMinute === null || ratePerMinute <= 0) {
        return base;
    }

    // The clock starts at the last sample: that is the utilization the rate continues from.
    const minutes = projectTimeToLimit(last.utilization, ratePerMinute);
    const exhaustMs = minutes === null ? null : lastMs + minutes * 60_000;
    const toResetMin = hasReset ? (resetMs - lastMs) / 60_000 : null;

    return {
        ...base,
        ratePctPerHour: Math.round(ratePerMinute * 60 * 100) / 100,
        basis,
        exhaustAt: exhaustMs === null ? null : iso(exhaustMs),
        minutesToExhaust: exhaustMs === null ? null : Math.max(0, Math.round((exhaustMs - nowMs) / 60_000)),
        beforeReset: exhaustMs !== null && hasReset && exhaustMs < resetMs,
        projectedAtReset:
            toResetMin === null ? null : Math.round((last.utilization + ratePerMinute * toResetMin) * 10) / 10,
    };
}

function warningOf(windows: readonly WindowForecast[]): string | null {
    const early = windows
        .filter((window) => window.beforeReset && window.exhaustAt)
        .sort((left, right) => (left.exhaustAt ?? "").localeCompare(right.exhaustAt ?? ""))[0];

    if (!early?.exhaustAt) {
        return null;
    }

    const at = new Date(early.exhaustAt);
    return `${early.label} runs out at ${at.toTimeString().slice(0, 5)}, before its reset`;
}

/** Groups samples (any order) by provider/account/bucket and forecasts each window. */
export function forecastFromSamples(samples: readonly UsageSample[], now: Date = new Date()): AccountForecast[] {
    const groups = new Map<string, UsageSample[]>();

    for (const sample of samples) {
        const key = `${sample.provider}\u0000${sample.account}\u0000${sample.bucket}`;
        const list = groups.get(key) ?? [];
        list.push(sample);
        groups.set(key, list);
    }

    const accounts = new Map<string, AccountForecast>();
    const order: Record<ForecastWindowKind, number> = { session: 0, weekly: 1, scoped: 2 };

    for (const list of groups.values()) {
        list.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
        const window = forecastWindow(list, now);

        if (!window) {
            continue;
        }

        const { provider, account } = list[0];
        const key = `${provider}\u0000${account}`;
        const entry = accounts.get(key) ?? { provider, account, windows: [], warning: null };
        entry.windows.push(window);
        accounts.set(key, entry);
    }

    return [...accounts.values()]
        .map((entry) => {
            const windows = entry.windows.sort(
                (left, right) => order[left.kind] - order[right.kind] || left.bucket.localeCompare(right.bucket)
            );
            return { ...entry, windows, warning: warningOf(windows) };
        })
        .sort(
            (left, right) => left.provider.localeCompare(right.provider) || left.account.localeCompare(right.account)
        );
}

interface SampleRow {
    provider: string;
    account_name: string;
    bucket: string;
    kind: string | null;
    utilization: number;
    resets_at: string | null;
    timestamp: string;
}

/** The samples of the lookback, filters in the WHERE clause (never after a full read). */
export function readUsageSamples(
    db: Database,
    options: { since: Date; provider?: string; account?: string }
): UsageSample[] {
    const rows = db
        .prepare(
            `SELECT provider, account_name, bucket, kind, utilization, resets_at, timestamp
             FROM usage_snapshots
             WHERE timestamp >= ?1
               AND (?2 IS NULL OR provider = ?2)
               AND (?3 IS NULL OR account_name = ?3)
             ORDER BY timestamp ASC`
        )
        .all(options.since.toISOString(), options.provider ?? null, options.account ?? null) as SampleRow[];

    return rows.map((row) => ({
        provider: row.provider,
        account: row.account_name,
        bucket: row.bucket,
        kind: row.kind,
        utilization: row.utilization,
        resetsAt: row.resets_at,
        timestamp: row.timestamp,
    }));
}

export async function buildForecast({
    provider,
    account,
    now = new Date(),
    open = () => openHistoryReadOnly(),
}: {
    provider?: string;
    account?: string;
    now?: Date;
    open?: () => Database | undefined;
} = {}): Promise<ForecastResult> {
    const started = performance.now();
    const db = open();

    if (!db) {
        log.debug("forecast: no history database yet");
        return { generatedAt: now.toISOString(), source: null, accounts: [], elapsedMs: 0 };
    }

    try {
        const samples = readUsageSamples(db, {
            since: new Date(now.getTime() - FORECAST_LOOKBACK_MS),
            provider,
            account,
        });
        const accounts = forecastFromSamples(samples, now);
        const elapsedMs = Math.round(performance.now() - started);
        log.debug({ samples: samples.length, accounts: accounts.length, elapsedMs }, "forecast built");
        return { generatedAt: now.toISOString(), source: db.filename, accounts, elapsedMs };
    } catch (error) {
        // An index older than the usage columns has no `usage_snapshots`: that is "no data", not a crash.
        log.warn({ error }, "forecast: usage_snapshots unreadable");
        return { generatedAt: now.toISOString(), source: db.filename, accounts: [], elapsedMs: 0 };
    } finally {
        db.close();
    }
}
