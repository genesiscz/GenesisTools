import type { Database } from "bun:sqlite";
import { openHistoryReadOnly } from "@genesiscz/utils/agent-sessions/database";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/providers/account-features";
import { isLimitKind, LIMIT_KIND_VALUES, type LimitKind } from "@genesiscz/utils/ai/providers/account-features";
import { rankAccounts } from "@genesiscz/utils/ai/usage/account-rank";
import {
    ADVISE_PROFILE_IDS,
    type AdviseData,
    adviseAccounts,
    LIMITS_ADVISE_SCHEMA,
} from "@genesiscz/utils/ai/usage/advise";
import {
    type AccountKey,
    accountKeysOf,
    parseStep,
    refuseHarness,
    resolveProviderList,
    resolveStepMs,
    resolveWindow,
    selectAccounts,
    splitList,
    type UsageEnvelope,
    UsageQueryError,
    type UsageWarning,
    usageEnvelope,
    type WindowFlags,
} from "@genesiscz/utils/ai/usage/contract";
import { absentKey, FORECAST_LOOKBACK_MS, forecastFromSamples } from "@genesiscz/utils/ai/usage/forecast/forecast";
import { LIMITS_HEALTH_SCHEMA, type LimitsHealthData, limitsHealth } from "@genesiscz/utils/ai/usage/poll-runs/health";
import { type PollRun, PollRunsStore } from "@genesiscz/utils/ai/usage/poll-runs/store";
import { usageDaemonAgeMs } from "@genesiscz/utils/ai/usage-poll/daemon-heartbeat";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import {
    LIMITS_NOW_SCHEMA,
    type LimitsNowData,
    limitsNow,
    snapshotsFromCache,
    usageAccountKeys,
} from "@genesiscz/utils/ai/usage-poll/limits-now";
import { pollAccounts, usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import { LIMITS_SERIES_SCHEMA, type LimitSeriesData, readLimitSeries } from "@genesiscz/utils/ai/usage-poll/series";
import type { SeriesAgg } from "@genesiscz/utils/ai/usage-poll/series-rows";
import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";

/**
 * The answers behind `tools ai usage limits`, `limits series` and `limits advise` (design 2026-11-01, steps U1 to
 * U4), shared by the CLI verbs and the `usage_*` MCP tools: flags in, one `usage.<verb>@1` envelope out. Rendering
 * stays with each door.
 */

export const TOOL = "tools ai usage";

export const AGG_VALUES: readonly SeriesAgg[] = ["last", "minmax", "raw"];

export interface LimitsOptions {
    provider?: string[] | boolean;
    account?: string[];
    json?: boolean;
    fresh?: boolean;
    cached?: boolean;
    harness?: string[] | boolean;
    /** Rank every account with its provider's ranker (`data.ranked`). */
    scored?: boolean;
}

export interface AdviseOptions extends LimitsOptions {
    /** Extra `model:<name>` profiles. */
    model?: string[];
}

export interface SeriesOptions extends LimitsOptions, WindowFlags {
    step?: string;
    agg?: string | boolean;
    kind?: string[] | boolean;
}

interface GatheredSnapshots {
    snapshots: AccountUsageSnapshot[];
    providers: string[] | undefined;
    providerIds: string[];
    selection: AccountKey[] | undefined;
    noCache: boolean;
}

/** The snapshots a limits verb answers from: polled (the shared cache gates it) or, with `cached`, the last poll's file. */
async function gatherSnapshots(opts: LimitsOptions): Promise<GatheredSnapshots> {
    refuseHarness(opts.harness);

    if (opts.cached && opts.fresh) {
        throw new UsageQueryError("bad-value", "--cached never polls and --fresh always does; pass one of them.");
    }

    const providers = resolveProviderList(opts.provider);
    const providerIds = providers ?? usagePlugins().map((entry) => entry.plugin.id);
    const store = await AiConfigStore.readOnly();
    const candidates = usageAccountKeys(store.accounts(), providerIds, { visibleOnly: true });
    const selection = selectAccounts(opts.account, candidates);
    const pollProviders = selection ? [...new Set(selection.map((account) => account.provider))] : providers;
    const cache = opts.cached ? await readSnapshotsCache() : null;
    const snapshots = opts.cached
        ? snapshotsFromCache(cache)
        : await pollAccounts({
              ...(pollProviders === undefined ? {} : { providers: pollProviders }),
              ...(selection === undefined ? {} : { accountFilter: selection.map((account) => account.accountName) }),
              ...(opts.fresh ? { force: true } : {}),
          });

    return { snapshots, providers, providerIds, selection, noCache: opts.cached === true && cache === null };
}

const NO_CACHE_WARNING: UsageWarning = {
    code: "no-cache",
    message: `No poll has written the snapshots file yet. Run ${TOOL} limits without --cached.`,
};

/** `tools ai usage limits`: every account's windows now, as `usage.limits@1`. */
export async function queryLimitsNow(opts: LimitsOptions): Promise<UsageEnvelope<LimitsNowData>> {
    const { snapshots, providers, providerIds, selection, noCache } = await gatherSnapshots(opts);
    const { data, warnings } = limitsNow(snapshots, {
        ...(providers === undefined ? {} : { providers }),
        ...(selection === undefined ? {} : { accounts: selection }),
    });

    if (opts.scored) {
        // The rankers read `native` (Claude's per-model windows), which the wire copy drops.
        const shown = new Set(data.accounts.map((account) => `${account.provider}\u0000${account.accountId}`));
        data.ranked = rankAccounts(
            snapshots.filter((snapshot) => shown.has(`${snapshot.provider}\u0000${snapshot.accountId}`))
        );
    }

    if (noCache) {
        warnings.push(NO_CACHE_WARNING);
    }

    logger.debug(
        {
            providers: providerIds,
            selected: selection?.length,
            accounts: data.accounts.length,
            cached: opts.cached === true,
            scored: opts.scored === true,
        },
        "[ai-usage] limits now"
    );

    return usageEnvelope({
        ...LIMITS_NOW_SCHEMA,
        now: new Date(),
        accounts: selection ?? accountKeysOf(data.accounts),
        data,
        warnings,
    });
}

/** `tools ai usage limits advise`: the next account per workload and the capacity left unused at each reset. */
export async function queryAdvice(
    opts: AdviseOptions,
    db: UsageLimitsDb = new UsageLimitsDb()
): Promise<UsageEnvelope<AdviseData>> {
    const { snapshots, providers, selection, noCache } = await gatherSnapshots(opts);
    const shown = snapshots.filter(
        (snapshot) =>
            (!providers || providers.includes(snapshot.provider)) &&
            (!selection ||
                selection.some(
                    (account) => account.provider === snapshot.provider && account.accountId === snapshot.accountId
                ))
    );
    const now = new Date();
    const absent = new Map(
        shown.map((snapshot) => [
            absentKey(snapshot.provider, snapshot.accountName),
            (snapshot.absentLimits ?? []).map((limit) => limit.key),
        ])
    );
    const forecasts = forecastFromSamples(
        db.getForecastSamples({ since: new Date(now.getTime() - FORECAST_LOOKBACK_MS) }),
        {
            now,
            absent,
        }
    ).filter((account) => absent.has(absentKey(account.provider, account.account)));
    const models = splitList(opts.model);
    const data = adviseAccounts({ snapshots: shown, forecasts, models, now });
    const warnings: UsageWarning[] = noCache ? [NO_CACHE_WARNING] : [];

    logger.debug(
        { accounts: shown.length, forecasts: forecasts.length, profiles: ADVISE_PROFILE_IDS.length + models.length },
        "[ai-usage] limits advise"
    );

    return usageEnvelope({
        ...LIMITS_ADVISE_SCHEMA,
        now,
        accounts: selection ?? accountKeysOf(shown),
        data,
        warnings,
    });
}

function resolveAgg(raw: string | boolean | undefined): SeriesAgg {
    if (raw === undefined || raw === false) {
        return "last";
    }

    const given = raw === true ? undefined : raw.trim().toLowerCase();
    const agg = AGG_VALUES.find((value) => value === given);

    if (agg === undefined) {
        throw new UsageQueryError(
            "bad-value",
            suggestEnumFlag(TOOL, "--agg", AGG_VALUES, {
                subcommand: ["limits", "series"],
                ...(raw === true ? {} : { given: raw }),
            })
        );
    }

    return agg;
}

function resolveKinds(raw: string[] | boolean | undefined): LimitKind[] | undefined {
    if (raw === undefined || raw === false) {
        return undefined;
    }

    const list = splitList(raw);
    const bad = raw === true || list.length === 0 ? "" : list.find((value) => !isLimitKind(value));

    if (bad !== undefined) {
        throw new UsageQueryError(
            "bad-value",
            suggestEnumFlag(TOOL, "--kind", LIMIT_KIND_VALUES, {
                subcommand: ["limits", "series"],
                ...(bad ? { given: bad } : {}),
            })
        );
    }

    return list.filter(isLimitKind);
}

/** `tools ai usage limits series`: limit windows over time, as `usage.limits.series@1`. */
export async function querySeries(opts: SeriesOptions): Promise<UsageEnvelope<LimitSeriesData>> {
    refuseHarness(opts.harness);

    const now = new Date();
    const window = resolveWindow(opts, { now, defaultSince: "24h" });
    const stepMs = resolveStepMs(parseStep(opts.step), window);
    const agg = resolveAgg(opts.agg);
    const kinds = resolveKinds(opts.kind);
    const providers = resolveProviderList(opts.provider);
    const providerIds = providers ?? usagePlugins().map((entry) => entry.plugin.id);
    const store = await AiConfigStore.readOnly();
    const db = new UsageLimitsDb();
    const directory = usageAccountKeys(store.accounts(), providerIds, { visibleOnly: false });
    const known = new Set(directory.map((account) => `${account.provider}\u0000${account.accountName}`));
    // History outlives config: an account removed from config still has rows under its name,
    // and `--account <old name>` must find them.
    const orphans: AccountKey[] = db
        .getAllAccountBuckets()
        .filter((row) => providerIds.includes(row.provider) && !known.has(`${row.provider}\u0000${row.accountName}`))
        .map((row) => ({ provider: row.provider, accountId: row.accountName, accountName: row.accountName }));
    const selection = selectAccounts(opts.account, [...directory, ...accountKeysOf(orphans)]);
    const cache = await readSnapshotsCache();
    const data = readLimitSeries(
        {
            from: window.from.toISOString(),
            to: window.to.toISOString(),
            stepMs,
            agg,
            ...(selection === undefined ? {} : { accounts: selection }),
            ...(providers === undefined ? {} : { providers }),
            ...(kinds === undefined ? {} : { kinds }),
            forecastAt: now,
        },
        { db, directory, current: snapshotsFromCache(cache) }
    );
    const warnings: UsageWarning[] = [];

    if (cache === null) {
        warnings.push({
            code: "no-current",
            message: `No poll has written the snapshots file yet, so every "current" is null. Run ${TOOL} limits once.`,
        });
    }

    logger.debug(
        { window: window.label, tz: window.tz, stepMs, agg, series: data.series.length, selected: selection?.length },
        "[ai-usage] limits series"
    );

    return usageEnvelope({
        ...LIMITS_SERIES_SCHEMA,
        now,
        window,
        accounts: selection ?? accountKeysOf(data.series),
        data,
        warnings,
    });
}

export interface HealthOptions extends LimitsOptions, WindowFlags {}

export interface HealthDeps {
    /** A read-only connection to the history store, or undefined when there is none yet. */
    open?: () => Database | undefined;
    heartbeatAgeMs?: () => number | null;
    now?: Date;
}

/**
 * `tools ai usage limits health`: what the poller knew per account over the window, as `usage.limits.health@1`. A
 * diagnostic, so it never polls and never migrates: the runs come through a read-only connection, and a store the
 * coverage migration has not reached answers no runs with a warning.
 */
export async function queryHealth(
    opts: HealthOptions,
    deps: HealthDeps = {}
): Promise<UsageEnvelope<LimitsHealthData>> {
    refuseHarness(opts.harness);

    const now = deps.now ?? new Date();
    const window = resolveWindow(opts, { now, defaultSince: "24h" });
    const providers = resolveProviderList(opts.provider);
    const providerIds = providers ?? usagePlugins().map((entry) => entry.plugin.id);
    const store = await AiConfigStore.readOnly();
    const candidates = usageAccountKeys(store.accounts(), providerIds, { visibleOnly: true });
    const selection = selectAccounts(opts.account, candidates);
    const db = (deps.open ?? (() => openHistoryReadOnly()))();
    let runs: PollRun[] = [];
    let lastRoundAt: string | null = null;

    try {
        if (db) {
            const runStore = new PollRunsStore(db);
            runs = runStore.runsBetween({ from: window.from, to: window.to, providers: providerIds });
            lastRoundAt = runStore.lastRoundAt();
        }
    } finally {
        db?.close();
    }

    const accounts = selection ?? candidates;
    const { data, warnings } = limitsHealth({
        accounts,
        runs,
        window,
        now,
        heartbeatAgeMs: (deps.heartbeatAgeMs ?? usageDaemonAgeMs)(),
        lastRoundAt,
    });

    logger.debug(
        { window: window.label, accounts: accounts.length, runs: runs.length, lastRoundAt },
        "[ai-usage] limits health"
    );

    return usageEnvelope({ ...LIMITS_HEALTH_SCHEMA, now, window, accounts, data, warnings });
}
