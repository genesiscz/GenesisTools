import type { Database } from "bun:sqlite";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import { isLimitKind, type LimitKind } from "@genesiscz/utils/ai/providers/account-features";
import { readUsageSamples, type UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { logger } from "@genesiscz/utils/logger";
import { activeDeltas, chooseRate, MIN_ACTIVE_SAMPLES, percentile } from "./burn-pace";
import { projectTimeToLimit, type TimestampedValue } from "./rate-math";

// `tools hub forecast`: when each account's current 5-hour and weekly windows run out at the recent
// burn rate. It only READS `usage_snapshots` (what the usage poller already recorded) through a
// read-only handle: no API fetch, no schema write (`UsageLimitsDb` runs CREATE/ALTER on open). It also
// reads the poller's `snapshots.json` for the windows an account no longer has (`absentLimits`): the
// table keeps an absent window's last rows, and a forecast from them described a window that is gone.

const log = logger.child({ component: "hub/forecast" });

export type ForecastWindowKind = "session" | "weekly" | "scoped";
export type ForecastBasis = "active" | "rolling" | "window";

export interface WindowForecast {
    bucket: string;
    kind: ForecastWindowKind;
    label: string;
    /** Percent used at the last sample. */
    utilization: number;
    resetsAt: string | null;
    lastSampleAt: string;
    /** Readings of the whole lookback, earlier reset cycles included. */
    samples: number;
    /** Readings of the current reset cycle: the only ones the rate reads, so the only evidence about this cycle. */
    cycleSamples: number;
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
    /**
     * Bucket keys the account does not have, from its current usage snapshot (`["five_hour"]` for an
     * account without a 5-hour limit). None of them is in `windows`. Omitted when nothing is absent.
     */
    absentWindows?: string[];
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

/**
 * A calendar month before `ms` (UTC), the span of a monthly or credit window. The day is clamped to the shorter
 * month (a reset on March 31 started on February 28 or 29), where `setUTCMonth` would roll over into March.
 */
function monthBefore(ms: number): number {
    const at = new Date(ms);
    const day = at.getUTCDate();
    at.setUTCDate(1);
    at.setUTCMonth(at.getUTCMonth() - 1);
    const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
    at.setUTCDate(Math.min(day, last));
    return at.getTime();
}

/**
 * Where a window began, from the provider's `LimitKind` (the `kind` column) and its reset, or from
 * now when it names no reset. A monthly window used to fall into `scoped` with a 7-day period, so for
 * a month with 20 days left its start lay 13 days in the future and no sample ever counted.
 */
const WINDOW_START: Record<LimitKind, (anchorMs: number) => number> = {
    session: (anchorMs) => anchorMs - 5 * HOUR,
    weekly: (anchorMs) => anchorMs - 7 * 24 * HOUR,
    scoped: (anchorMs) => anchorMs - 7 * 24 * HOUR,
    monthly: monthBefore,
    credit: monthBefore,
};

/** The window's start: by its stored kind, else (a row from before the kind column) by the bucket-name kind. */
export function windowStartMs(sample: Pick<UsageSample, "kind" | "bucket">, anchorMs: number): number {
    if (isLimitKind(sample.kind)) {
        return WINDOW_START[sample.kind](anchorMs);
    }

    return anchorMs - PERIOD_MS[windowKind(sample)];
}

/** The spread of the active burn: the 25th and 75th percentile, in percent per hour. */
export interface PaceBand {
    lowPctPerHour: number;
    highPctPerHour: number;
}

/** A forecast with its uncertainty and its budget: what the series door shows beside the burn lane (P5). */
export interface LimitForecast extends WindowForecast {
    /** Null under three active samples, where the rate is a rolling average and a band would be noise. */
    paceBand: PaceBand | null;
    /** The constant rate that lands at exactly 100 % at the reset; null without a reset ahead. */
    safePctPerHour: number | null;
}
/** A weekly average spreads its use over at least a day, so the night after a reset counts. */
const MIN_AVERAGE_SPAN_MIN = 24 * 60;
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

    // `seven_day_fable` read "7d fable" beside "5h" and "Weekly"; it is the weekly window of one model.
    const model = /^seven_day_(.+)$/.exec(bucket)?.[1];

    if (model) {
        return `Weekly ${model.charAt(0).toUpperCase()}${model.slice(1).replace(/_/g, " ")}`;
    }

    return bucket.replace(/^product:/, "");
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
    const { windowStart, values } = currentWindow(samples, now);
    const base: WindowForecast = {
        bucket: last.bucket,
        kind,
        label: windowLabel(last.bucket, kind),
        utilization: last.utilization,
        resetsAt: last.resetsAt,
        lastSampleAt: last.timestamp,
        samples: samples.length,
        cycleSamples: values.length,
        ratePctPerHour: null,
        basis: null,
        exhaustAt: null,
        minutesToExhaust: null,
        beforeReset: false,
        projectedAtReset: null,
        resetSinceSample,
        stale: nowMs - lastMs > STALE_MS[kind],
    };

    // No sample for hours: the account may have been idle since, so a burn carried forward from the
    // last sample is a guess. It named "out 19:00" at 21:45 for an account last sampled two days earlier.
    if (resetSinceSample || base.stale) {
        return base;
    }

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
            // Three busy hours after a reset, averaged over those hours alone, read as a 24/7 burn:
            // 3 % used showed "out Wed" for a window that resets on Saturday.
            ratePerMinute = last.utilization / Math.max(elapsedMin, MIN_AVERAGE_SPAN_MIN);
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
        ratePctPerHour: perHour(ratePerMinute),
        basis,
        exhaustAt: exhaustMs === null ? null : iso(exhaustMs),
        minutesToExhaust: exhaustMs === null ? null : Math.max(0, Math.round((exhaustMs - nowMs) / 60_000)),
        beforeReset: exhaustMs !== null && hasReset && exhaustMs < resetMs,
        projectedAtReset:
            toResetMin === null ? null : Math.round((last.utilization + ratePerMinute * toResetMin) * 10) / 10,
    };
}

/** Only samples of the current window: a rise across a reset is not a burn. */
function currentWindow(
    samples: readonly UsageSample[],
    now: Date
): { windowStart: number; values: TimestampedValue[] } {
    const last = samples[samples.length - 1];
    const resetMs = last.resetsAt ? Date.parse(last.resetsAt) : Number.NaN;
    const windowStart = windowStartMs(last, Number.isFinite(resetMs) ? resetMs : now.getTime());
    const values = samples
        .filter((sample) => Date.parse(sample.timestamp) >= windowStart)
        .map((sample) => ({ timestamp: sample.timestamp, value: sample.utilization }));

    return { windowStart, values };
}

function perHour(ratePerMinute: number): number {
    return Math.round(ratePerMinute * 60 * 100) / 100;
}

/** The 25th to 75th percentile of the current window's active burn; null under three active samples. */
export function paceBand(samples: readonly UsageSample[], now: Date = new Date()): PaceBand | null {
    if (samples.length === 0) {
        return null;
    }

    const deltas = activeDeltas(currentWindow(samples, now).values);
    const low = percentile(deltas, 0.25);
    const high = percentile(deltas, 0.75);

    if (deltas.length < MIN_ACTIVE_SAMPLES || low === undefined || high === undefined) {
        return null;
    }

    return { lowPctPerHour: perHour(low), highPctPerHour: perHour(high) };
}

/** `(100 - used) / hours to the reset`: the pace that uses the whole window and no more. */
export function safePctPerHour(
    window: Pick<WindowForecast, "utilization" | "resetsAt" | "resetSinceSample">,
    now: Date = new Date()
): number | null {
    const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    const hours = (resetMs - now.getTime()) / HOUR;

    if (window.resetSinceSample || !Number.isFinite(hours) || hours <= 0) {
        return null;
    }

    return Math.round((Math.max(0, 100 - window.utilization) / hours) * 100) / 100;
}

/** `forecastWindow` plus the pace band and the safe pace. Only new doors print it; `tools hub forecast` keeps its shape. */
export function forecastOutlook(samples: readonly UsageSample[], now: Date = new Date()): LimitForecast | null {
    const window = forecastWindow(samples, now);

    if (!window) {
        return null;
    }

    return { ...window, paceBand: paceBand(samples, now), safePctPerHour: safePctPerHour(window, now) };
}

/** A run-out time as a reader takes it: the clock for today, else the day with it ("Tue Sep 29 22:32"). */
export function forecastClock(date: Date, now: Date = new Date()): string {
    const time = date.toTimeString().slice(0, 5);
    return date.toDateString() === now.toDateString() ? time : `${date.toDateString().slice(0, 10)} ${time}`;
}

function warningOf(windows: readonly WindowForecast[], nowMs: number): string | null {
    const early = windows
        .filter((window) => window.beforeReset && window.exhaustAt)
        .sort((left, right) => (left.exhaustAt ?? "").localeCompare(right.exhaustAt ?? ""))[0];

    if (!early?.exhaustAt) {
        return null;
    }

    const at = new Date(early.exhaustAt);

    // The projection starts at the last sample; by now its run-out time can already be behind us.
    if (at.getTime() <= nowMs) {
        return `${early.label} is projected at its limit now, before its reset`;
    }

    // The clock alone read as today for a run-out two days away ("Weekly runs out at 22:32").
    return `${early.label} runs out at ${forecastClock(at, new Date(nowMs))}, before its reset`;
}

/** Absent bucket keys per account, keyed by `absentKey(provider, account)`. */
export type AbsentWindows = ReadonlyMap<string, readonly string[]>;

export function absentKey(provider: string, account: string): string {
    return `${provider}\u0000${account}`;
}

/** The absent windows the poller's last snapshots name, read-only. An unreadable file means none known. */
export async function readAbsentWindows(): Promise<AbsentWindows> {
    const absent = new Map<string, string[]>();

    try {
        const cache = await readSnapshotsCache();

        for (const [provider, entry] of Object.entries(cache?.providers ?? {})) {
            for (const snapshot of entry.accounts) {
                const keys = (snapshot.absentLimits ?? []).map((limit) => limit.key);

                if (keys.length > 0) {
                    absent.set(absentKey(provider, snapshot.accountName), keys);
                }
            }
        }
    } catch (error) {
        log.debug({ error }, "forecast: snapshots.json unreadable; no window is known absent");
    }

    return absent;
}

/**
 * Groups samples (any order) by provider/account/bucket and forecasts each window. A bucket the account's
 * current snapshot lists as absent gets no window: its rows are history of a window the account lost.
 */
export function forecastFromSamples(
    samples: readonly UsageSample[],
    { now = new Date(), absent = new Map() }: { now?: Date; absent?: AbsentWindows } = {}
): AccountForecast[] {
    const groups = new Map<string, UsageSample[]>();

    for (const sample of samples) {
        if (absent.get(absentKey(sample.provider, sample.account))?.includes(sample.bucket)) {
            continue;
        }

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
        const key = absentKey(provider, account);
        const absentWindows = absent.get(key);
        const entry = accounts.get(key) ?? {
            provider,
            account,
            windows: [],
            ...(absentWindows?.length ? { absentWindows: [...absentWindows] } : {}),
            warning: null,
        };
        entry.windows.push(window);
        accounts.set(key, entry);
    }

    return [...accounts.values()]
        .map((entry) => {
            const windows = entry.windows.sort(
                (left, right) => order[left.kind] - order[right.kind] || left.bucket.localeCompare(right.bucket)
            );
            return { ...entry, windows, warning: warningOf(windows, now.getTime()) };
        })
        .sort(
            (left, right) => left.provider.localeCompare(right.provider) || left.account.localeCompare(right.account)
        );
}

export async function buildForecast({
    provider,
    account,
    now = new Date(),
    open = () => openHistoryReadOnly(),
    readAbsent = readAbsentWindows,
}: {
    provider?: string;
    account?: string;
    now?: Date;
    open?: () => Database | undefined;
    readAbsent?: () => Promise<AbsentWindows>;
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
        const absent = await readAbsent();
        const accounts = forecastFromSamples(samples, { now, absent });
        const elapsedMs = Math.round(performance.now() - started);
        log.debug({ samples: samples.length, accounts: accounts.length, elapsedMs }, "forecast built");
        return { generatedAt: now.toISOString(), source: db.filename, accounts, elapsedMs };
    } catch (error) {
        // An index older than the usage columns has no `usage_snapshots`: that is "no data", not a crash.
        // Anything else (a corrupt file, an I/O error) is a failure the command must report.
        if (!(error instanceof Error && /no such (table|column)/.test(error.message))) {
            throw error;
        }

        log.warn({ error }, "forecast: usage_snapshots unreadable");
        return { generatedAt: now.toISOString(), source: db.filename, accounts: [], elapsedMs: 0 };
    } finally {
        db.close();
    }
}
