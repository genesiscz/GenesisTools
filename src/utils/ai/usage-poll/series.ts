import {
    type AbsentLimit,
    absentLimitKindLabel,
    isLimitKind,
    type LimitKind,
    type LimitSeverity,
    type LimitWindow,
} from "@genesiscz/utils/ai/providers/account-features";
import type { AccountKey } from "@genesiscz/utils/ai/usage/contract/envelope";
import { autoSeriesStepMs } from "@genesiscz/utils/ai/usage/contract/step";
import { FORECAST_LOOKBACK_MS, forecastOutlook, type LimitForecast } from "@genesiscz/utils/ai/usage/forecast/forecast";
import type { UsageSample } from "@genesiscz/utils/ai/usage/forecast/samples";
import type { UsageLimitsDb } from "./limits-db";
import type { AvailabilitySpan, SeriesAgg, SeriesBinEntry, SeriesEntry } from "./series-rows";
import type { AccountUsageSnapshot } from "./types";

/** `usage.limits.series@1`: the verb and its shape version. */
export const LIMITS_SERIES_SCHEMA = { verb: "limits.series", version: 1 } as const;

export interface LimitSeriesPoint {
    t: string;
    /** Percent of the window used, 0..100 (may exceed 100). */
    v: number;
    severity: LimitSeverity | null;
}

export interface LimitSeriesBin {
    /** Bin start: the bucket start, or the first row after a reset that split the bucket. */
    t: string;
    open: number;
    close: number;
    min: number;
    max: number;
    severity: LimitSeverity | null;
}

/** Window presence over time (design section 6): one span per state, from the store's `availability` column. */
export type { AvailabilitySpan as LimitAvailabilitySpan } from "./series-rows";

export interface LimitCurrent {
    utilization: number;
    resetsAt: string | null;
    severity: LimitSeverity | null;
    /** When the poll that produced this value ran. */
    fetchedAt: string;
}

interface LimitSeriesItemBase extends AccountKey {
    /** Provider-native window key (`five_hour`, `primary`). Consumers key on kind and scope; this disambiguates two scoped windows of one kind. */
    key: string;
    kind: LimitKind | null;
    scopeModel: string | null;
    label: string;
    periodMs: number | null;
    availability: AvailabilitySpan[];
    /**
     * The newest poll's word on this window: `limited` when it reported the window, `absent` when it
     * listed it in `absentLimits` (the account no longer has it, so the line ends), `unknown` when it
     * said neither or no poll has run.
     */
    availableNow: "limited" | "absent" | "unknown";
}

interface LimitSeriesItemTail {
    /** Instants a new window began. */
    resets: string[];
    /** The newest poll's reading of this window, or null when the cache holds none. */
    current: LimitCurrent | null;
    /**
     * The window's run-out at its recent burn, with the pace band and the safe pace (P5). Null
     * when the request did not ask for it, the window is absent now, or it has no recent samples.
     */
    forecast: LimitForecast | null;
}

export type LimitSeriesPointItem = LimitSeriesItemBase & { points: LimitSeriesPoint[] } & LimitSeriesItemTail;
export type LimitSeriesBinItem = LimitSeriesItemBase & { bins: LimitSeriesBin[] } & LimitSeriesItemTail;
export type LimitSeriesItem = LimitSeriesPointItem | LimitSeriesBinItem;

export interface LimitSeriesData<T extends LimitSeriesItem = LimitSeriesItem> {
    stepMs: number;
    agg: SeriesAgg;
    series: T[];
}

export interface LimitSeriesRequest {
    /** ISO instants. */
    from: string;
    to: string;
    /** Bin width in ms; 0 asks for every row. Omitted is `autoSeriesStepMs(from, to)`. */
    stepMs?: number;
    agg: SeriesAgg;
    /** Omitted: every account the store holds. Empty: none. Matched on provider and account name. */
    accounts?: readonly AccountKey[];
    /** Plugin ids. Omitted: every provider. */
    providers?: readonly string[];
    keys?: readonly string[];
    kinds?: readonly LimitKind[];
    /** Forecast each window as of this instant (the 8-day lookback before it). Omitted: no forecast. */
    forecastAt?: Date;
}

export interface LimitSeriesSources {
    db: UsageLimitsDb;
    /** Configured accounts. The store keys rows by name, so this is where a row gets its id. */
    directory: readonly AccountKey[];
    /** The newest poll's snapshots: each window's label, period and current value. */
    current: readonly AccountUsageSnapshot[];
}

const LIMIT_SEVERITIES: Record<LimitSeverity, true> = { ok: true, warn: true, critical: true };

function isLimitSeverity(value: string | null): value is LimitSeverity {
    return value !== null && Object.hasOwn(LIMIT_SEVERITIES, value);
}

function severityOf(value: string | null): LimitSeverity | null {
    return isLimitSeverity(value) ? value : null;
}

function pairKey(provider: string, accountName: string): string {
    return `${provider}\u0000${accountName}`;
}

interface CurrentWindow {
    window: LimitWindow;
    fetchedAt: string;
}

interface CurrentState {
    windows: ReadonlyMap<string, CurrentWindow>;
    absent: ReadonlyMap<string, AbsentLimit>;
}

/**
 * The series door's core (design section 6), shared by `tools ai usage limits series` and the
 * dev-dashboard `/api/ai/usage/series` route. It reads `usage_snapshots` through `getSeries`,
 * gives each row the config id of its account, and joins the newest poll's label, period and
 * value for the window.
 */
export function readLimitSeries(
    request: LimitSeriesRequest & { agg: "minmax" },
    sources: LimitSeriesSources
): LimitSeriesData<LimitSeriesBinItem>;
export function readLimitSeries(
    request: LimitSeriesRequest & { agg: "raw" | "last" },
    sources: LimitSeriesSources
): LimitSeriesData<LimitSeriesPointItem>;
export function readLimitSeries(request: LimitSeriesRequest, sources: LimitSeriesSources): LimitSeriesData;
export function readLimitSeries(request: LimitSeriesRequest, sources: LimitSeriesSources): LimitSeriesData {
    const stepMs = request.stepMs ?? autoSeriesStepMs(request.from, request.to);

    if (request.accounts?.length === 0 || request.providers?.length === 0) {
        return { stepMs, agg: request.agg, series: [] };
    }

    const names = request.accounts ? [...new Set(request.accounts.map((account) => account.accountName))] : undefined;
    const query = {
        from: request.from,
        to: request.to,
        step: stepMs,
        ...(request.providers?.length === 1 ? { provider: request.providers[0] } : {}),
        ...(names ? { accounts: names } : {}),
        ...(request.keys ? { keys: [...request.keys] } : {}),
        ...(request.kinds ? { kinds: [...request.kinds] } : {}),
    };
    const entries: Array<SeriesEntry | SeriesBinEntry> =
        request.agg === "minmax"
            ? sources.db.getSeries({ ...query, agg: "minmax" })
            : sources.db.getSeries({ ...query, agg: request.agg });
    const providers = request.providers ? new Set(request.providers) : undefined;
    const selected = request.accounts
        ? new Set(request.accounts.map((account) => pairKey(account.provider, account.accountName)))
        : undefined;
    const ids = new Map(
        sources.directory.map((account) => [pairKey(account.provider, account.accountName), account.accountId])
    );
    const windows = new Map<string, CurrentWindow>();
    const absent = new Map<string, AbsentLimit>();

    for (const snapshot of sources.current) {
        const pair = pairKey(snapshot.provider, snapshot.accountName);

        for (const window of snapshot.limits) {
            windows.set(`${pair}\u0000${window.key}`, { window, fetchedAt: snapshot.fetchedAt });
        }

        for (const limit of snapshot.absentLimits ?? []) {
            absent.set(`${pair}\u0000${limit.key}`, limit);
        }
    }

    const kept = entries
        .filter((entry) => !providers || providers.has(entry.provider))
        .filter((entry) => !selected || selected.has(pairKey(entry.provider, entry.account)));
    const samples = request.forecastAt ? forecastSamples(sources.db, request, request.forecastAt) : undefined;
    const series = kept.map((entry) => {
        const item = toItem(entry, ids, { windows, absent });

        if (!samples || !request.forecastAt || item.availableNow === "absent") {
            return item;
        }

        const own = (samples.get(`${pairKey(entry.provider, entry.account)}\u0000${entry.key}`) ?? []).filter(
            (sample) => entry.kind === null || sample.kind === null || sample.kind === entry.kind
        );
        return { ...item, forecast: forecastOutlook(own, request.forecastAt) };
    });

    return { stepMs, agg: request.agg, series };
}

/** The lookback's samples in one query, grouped by provider, account and window key. */
function forecastSamples(db: UsageLimitsDb, request: LimitSeriesRequest, at: Date): Map<string, UsageSample[]> {
    const groups = new Map<string, UsageSample[]>();
    const rows = db.getForecastSamples({
        since: new Date(at.getTime() - FORECAST_LOOKBACK_MS),
        ...(request.providers?.length === 1 ? { provider: request.providers[0] } : {}),
        ...(request.accounts?.length === 1 ? { account: request.accounts[0].accountName } : {}),
    });

    for (const row of rows) {
        if (Date.parse(row.timestamp) > at.getTime()) {
            continue;
        }

        const key = `${pairKey(row.provider, row.account)}\u0000${row.bucket}`;
        const list = groups.get(key) ?? [];
        list.push(row);
        groups.set(key, list);
    }

    return groups;
}

function toItem(
    entry: SeriesEntry | SeriesBinEntry,
    ids: ReadonlyMap<string, string>,
    state: CurrentState
): LimitSeriesItem {
    const pair = pairKey(entry.provider, entry.account);
    const found = state.windows.get(`${pair}\u0000${entry.key}`);
    const gone = found ? undefined : state.absent.get(`${pair}\u0000${entry.key}`);
    // A window that changed kind (a Codex slot after a plan change) splits into two series;
    // only the one whose kind matches today's window takes its label and current value.
    const current = found && (entry.kind === null || found.window.kind === entry.kind) ? found : undefined;
    const base: LimitSeriesItemBase = {
        provider: entry.provider,
        accountId: ids.get(pair) ?? entry.account,
        accountName: entry.account,
        key: entry.key,
        kind: isLimitKind(entry.kind) ? entry.kind : (current?.window.kind ?? gone?.kind ?? null),
        scopeModel: entry.scopeModel ?? current?.window.scopeModel ?? null,
        // An absent window carries no label of its own; its old rows keep a readable one.
        label: current?.window.label ?? (gone ? absentLimitKindLabel(gone) : entry.key),
        periodMs: current?.window.periodMs ?? null,
        availability: entry.availability,
        availableNow: current ? "limited" : gone ? "absent" : "unknown",
    };
    const tail: LimitSeriesItemTail = {
        resets: entry.resets,
        current: current
            ? {
                  utilization: current.window.percentUsed,
                  resetsAt: current.window.resetsAt ?? null,
                  severity: current.window.severity ?? null,
                  fetchedAt: current.fetchedAt,
              }
            : null,
        forecast: null,
    };

    if ("bins" in entry) {
        return {
            ...base,
            bins: entry.bins.map((bin) => ({ ...bin, severity: severityOf(bin.severity) })),
            ...tail,
        };
    }

    return {
        ...base,
        points: entry.points.map((point) => ({ t: point.t, v: point.percent, severity: severityOf(point.severity) })),
        ...tail,
    };
}
