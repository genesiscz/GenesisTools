import { registerUsagePollTask, USAGE_TASK_NAME } from "@app/ai/commands/usage/daemon";
import type { SpendSeriesResult } from "@app/ai-spend/lib/series";
import { getTask } from "@app/daemon/lib/config";
import { computeNextRunAt, parseInterval } from "@app/daemon/lib/interval";
import type {
    AccountRef,
    AiAccountListItem,
    AiAccountsResult,
    AiDaemonProviderStatus,
    AiDaemonStatus,
    AiProviderPresentation,
    AiSpendSeriesResult,
    AiSpendTotalsResult,
    AiUsageResult,
    AiUsageSeriesResult,
    LimitSeries,
    SpendAccountTotals,
    SpendBucket,
    SpendGrain,
    SpendSeriesPoint,
    SpendSource,
} from "@app/dev-dashboard/contract/ai-accounts";
import { CLAUDE_ALL_ACCOUNT_ID, UNBOUND_ACCOUNT_ID } from "@app/dev-dashboard/contract/ai-accounts";
import {
    filterSnapshots,
    flattenSnapshotsCache,
    limitSeriesFrom,
    providerAccountKey,
    resolveProviderFilter,
    type SnapshotFilter,
    spendAccountIds,
} from "@app/dev-dashboard/lib/ai-accounts/snapshots";
import type {
    TranscriptScanInput,
    TranscriptScanOutput,
} from "@app/dev-dashboard/lib/ai-accounts/transcript-scan-worker";
import { callWorker } from "@app/dev-dashboard/lib/ai-accounts/worker-call";
import { getRecentRuns } from "@app/dev-dashboard/lib/daemon-view/aggregator";
import { publishAiUsage } from "@app/dev-dashboard/lib/live/ai-usage-producer";
import { getLiveHub } from "@app/dev-dashboard/lib/live/singleton";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { AccountFeatures } from "@genesiscz/utils/ai/providers/account-features";
import { providerAliasOf } from "@genesiscz/utils/ai/providers/aliases";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { pluginsWithAccounts } from "@genesiscz/utils/ai/providers/registry";
import { CLAUDE_ALL_ACCOUNT_NAME, queryUsage, spendBucketKey } from "@genesiscz/utils/ai/usage";
import { readSnapshotsCache } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { logger } from "@genesiscz/utils/logger";

export interface UsageSeriesQuery extends SnapshotFilter {
    /** `LimitWindow.key` values. Empty means every window. */
    keys?: readonly string[];
    from: string;
    to: string;
    /** Downsample width in ms. */
    step?: number;
}

export interface SpendTotalsQuery {
    from: string;
    to: string;
    accounts?: readonly string[];
    /** Aliases or plugin ids. Empty or omitted means every provider. */
    providers?: readonly string[];
    source: SpendSource;
}

export interface SpendSeriesQuery extends SpendTotalsQuery {
    grain: SpendGrain;
}

/**
 * Everything the `/api/ai/*` routes need, behind one seam.
 *
 * The routes own parsing and status codes and nothing else, so a route test
 * injects a fake here instead of standing up a config store, a limits DB and a
 * transcript scan. `claudeRoutes` shares the same instance, which is what makes
 * the alias-parity test meaningful: both doors reach the same numbers.
 */
export interface AiAggregator {
    listAccounts(): Promise<AiAccountsResult>;
    /** Reads the poll cache. NEVER polls — see the diagnostics rule in CLAUDE.md. */
    getCurrentSnapshots(filter: SnapshotFilter): Promise<AiUsageResult>;
    refreshSnapshots(filter: SnapshotFilter): Promise<AiUsageResult>;
    getUsageSeries(query: UsageSeriesQuery): Promise<AiUsageSeriesResult>;
    getSpendTotals(query: SpendTotalsQuery): Promise<AiSpendTotalsResult>;
    getSpendSeries(query: SpendSeriesQuery): Promise<AiSpendSeriesResult>;
    /** Read-only. Never registers. */
    getAiDaemonStatus(): Promise<AiDaemonStatus>;
    registerAiDaemon(): Promise<{ ok: boolean }>;
}

/** Plan-AccountFeatures declares `accounts` on the plugin; read it structurally until it lands. */

/**
 * Credential FIELD NAMES the dashboard may report. A value never leaves this
 * process: the list answers "is this account logged in, and how", which is what
 * the empty-state CTA needs, and nothing more.
 */
const CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken", "longLivedToken", "authFile", "secondary"] as const;

function accountProviderIds(): Set<string> {
    return new Set(pluginsWithAccounts().map((plugin) => plugin.id));
}

function featuresByPlugin(): Map<string, AccountFeatures> {
    const out = new Map<string, AccountFeatures>();

    for (const plugin of pluginsWithAccounts()) {
        if (plugin.accounts) {
            out.set(plugin.id, plugin.accounts);
        }
    }

    return out;
}

function credentialKindsOf(account: AccountEntry): string[] {
    return CREDENTIAL_FIELDS.filter((field) => account.credentials[field] !== undefined);
}

function emptyBucket(): SpendBucket {
    return { costUsd: 0, tokens: 0 };
}

/**
 * Bucket VALUES are copied too, not only the map: a shallow spread left them
 * shared with the cached hourly scan, and the fold's `addBucket` then summed
 * into the cache itself, so an account with two hours in one day read $3 in
 * the cached first hour and every later fold inflated it again (eve review,
 * PR #363 t3).
 */
function cloneBucketMap(map: Record<string, SpendBucket>): Record<string, SpendBucket> {
    return Object.fromEntries(Object.entries(map).map(([key, bucket]) => [key, { ...bucket }]));
}

function addBucket(into: SpendBucket, from: SpendBucket): void {
    into.costUsd += from.costUsd;
    into.tokens += from.tokens;
}

function mergeBucketMaps(into: Record<string, SpendBucket>, from: Record<string, SpendBucket>): void {
    for (const [key, bucket] of Object.entries(from)) {
        const existing = into[key] ?? emptyBucket();
        addBucket(existing, bucket);
        into[key] = existing;
    }
}

/** Two series over the same axis fold into one. Points are keyed by `t`, which both producers build from `spendBucketKey`. */
function mergePoints(left: readonly SpendSeriesPoint[], right: readonly SpendSeriesPoint[]): SpendSeriesPoint[] {
    const byKey = new Map<string, SpendSeriesPoint>();

    for (const point of [...left, ...right]) {
        const existing = byKey.get(point.t);

        if (!existing) {
            byKey.set(point.t, {
                t: point.t,
                costUsd: point.costUsd,
                tokens: point.tokens,
                byAccount: cloneBucketMap(point.byAccount),
                ...(point.byModel ? { byModel: cloneBucketMap(point.byModel) } : {}),
            });
            continue;
        }

        existing.costUsd += point.costUsd;
        existing.tokens += point.tokens;
        mergeBucketMaps(existing.byAccount, point.byAccount);

        if (point.byModel) {
            existing.byModel = existing.byModel ?? {};
            mergeBucketMaps(existing.byModel, point.byModel);
        }
    }

    return [...byKey.values()].sort((a, b) => a.t.localeCompare(b.t));
}

function refFor(accountId: string, byId: Map<string, AccountEntry>): AccountRef {
    if (accountId === CLAUDE_ALL_ACCOUNT_ID) {
        return { accountId, accountName: CLAUDE_ALL_ACCOUNT_NAME, provider: "anthropic-sub" };
    }

    if (accountId === UNBOUND_ACCOUNT_ID) {
        return { accountId, accountName: accountId, provider: "" };
    }

    const account = byId.get(accountId);

    if (!account) {
        return { accountId, accountName: accountId, provider: "" };
    }

    return {
        accountId: account.id,
        accountName: account.name,
        provider: account.provider,
        label: account.label ?? providerAliasOf(account.provider),
    };
}

function dedupeRefs(refs: readonly AccountRef[]): AccountRef[] {
    const byId = new Map<string, AccountRef>();

    for (const ref of refs) {
        if (!byId.has(ref.accountId)) {
            byId.set(ref.accountId, ref);
        }
    }

    return [...byId.values()].sort((a, b) => a.accountName.localeCompare(b.accountName));
}

/** Transcripts are hour-resolution at best, so a `minute` request downgrades that half only. */
function transcriptGrain(grain: SpendGrain): Exclude<SpendGrain, "minute"> {
    return grain === "minute" ? "hour" : grain;
}

/**
 * The ONE axis a spend series is drawn on.
 *
 * `mergePoints` folds the call half into the transcript half by the bucket
 * STRING, so two halves bucketed at different widths never merge: a `both`
 * request at `minute` grain drew hourly transcript spikes beside minute buckets
 * and still labelled the result `minute`. Transcripts cannot resolve below an
 * hour, so a mixed request puts BOTH halves on the coarser axis.
 */
export function effectiveSpendGrain(source: SpendSource, grain: SpendGrain): SpendGrain {
    return source === "both" ? transcriptGrain(grain) : grain;
}

/**
 * The grain every transcript scan runs at.
 *
 * `buildSpendSeries` rejects `minute` (transcripts are hour-resolution at best),
 * so `hour` is the finest anything can ask for and every coarser axis folds from
 * it exactly. Fixing it here is what lets ONE scan answer both endpoints: the
 * bucketing is a single pass over events already in memory, so a finer grain
 * costs bucket entries, never another walk of the transcripts.
 */
const TRANSCRIPT_SCAN_GRAIN = "hour" as const;

/**
 * Two spend requests describing the same scan. The totals and the series
 * endpoints fire together on every page load with the same window, and each one
 * used to walk every transcript on disk: 21.8 s and 11.8 s respectively over 30
 * days, measured 2026-09-04, both synchronous and both on the request thread.
 * Sharing one scan halves that.
 *
 * The GRAIN is deliberately absent. It used to be part of the key while totals
 * asked for `day` and the series asked for whatever the window wanted, so the
 * two only shared a scan when the series also wanted `day`: the 1h, 6h and 24h
 * presets and any window long enough to want `week` ran two workers over the
 * same transcripts. Every caller now shares one hour-grain scan and folds it.
 */
export function transcriptScanKey(query: SpendTotalsQuery): string {
    return [query.from, query.to, [...(query.accounts ?? [])].sort().join(",")].join("|");
}

/** `YYYY-MM-DDTHH`, the shape `spendBucketKey` emits at hour grain. */
const HOUR_BUCKET_KEY = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;

/**
 * An hour bucket key re-read on a coarser axis.
 *
 * The keys are LOCAL wall clock by design (`src/utils/ai/usage/series-keys.ts`),
 * so the day is already spelled out in the key and the week is `spendBucketKey`'s
 * own Monday rule applied to that day. A `minute` request is answered with hour
 * buckets, exactly as before: transcripts cannot resolve finer.
 */
export function foldBucketKey(hourKey: string, grain: SpendGrain): string {
    if (grain === "hour" || grain === "minute") {
        return hourKey;
    }

    const parts = HOUR_BUCKET_KEY.exec(hourKey);

    if (!parts) {
        return hourKey;
    }

    const [, year, month, day, hour] = parts;

    if (grain === "day") {
        return `${year}-${month}-${day}`;
    }

    const at = new Date(Number(year), Number(month) - 1, Number(day), Number(hour));
    return spendBucketKey(at.toISOString(), grain);
}

/** Re-bucket an hour-grain series onto a coarser axis, summing what lands together. */
export function foldSpendPoints(points: readonly SpendSeriesPoint[], grain: SpendGrain): SpendSeriesPoint[] {
    if (grain === "hour" || grain === "minute") {
        return [...points];
    }

    const byKey = new Map<string, SpendSeriesPoint>();

    for (const point of points) {
        const t = foldBucketKey(point.t, grain);
        const existing = byKey.get(t);

        if (!existing) {
            byKey.set(t, {
                t,
                costUsd: point.costUsd,
                tokens: point.tokens,
                byAccount: cloneBucketMap(point.byAccount),
                ...(point.byModel ? { byModel: cloneBucketMap(point.byModel) } : {}),
            });
            continue;
        }

        existing.costUsd += point.costUsd;
        existing.tokens += point.tokens;
        mergeBucketMaps(existing.byAccount, point.byAccount);

        if (point.byModel) {
            existing.byModel = existing.byModel ?? {};
            mergeBucketMaps(existing.byModel, point.byModel);
        }
    }

    return [...byKey.values()].sort((a, b) => a.t.localeCompare(b.t));
}

/** Long enough to cover the two requests of one page load, short enough that a poll still shows up. */
const TRANSCRIPT_SCAN_TTL_MS = 15_000;

interface ScanEntry<T> {
    promise: Promise<T>;
    /** `null` while the work is still running. The TTL is measured from here. */
    settledAt: number | null;
}

export interface ScanCache<T> {
    /** The in-flight or fresh result for `key`, starting `run` only when there is neither. */
    share(key: string, run: () => Promise<T>): Promise<T>;
    /** Entry count, for tests and logging. */
    size(): number;
}

/**
 * Share one expensive result between the callers that arrive while it is useful.
 *
 * The TTL is measured from COMPLETION, not from the launch. A scan of a month of
 * transcripts takes about 20s against a 15s TTL, so a launch-stamped entry
 * expired while its own worker was still running: a second request evicted the
 * promise it should have awaited and started a duplicate worker, and a request
 * arriving just after the scan finished found the fresh result already stale.
 * In-flight work is therefore never evicted, and a failure only drops the entry
 * it belongs to, so a slow failing scan cannot delete the replacement that took
 * its key in the meantime.
 */
export function createScanCache<T>(ttlMs: number, now: () => number = Date.now): ScanCache<T> {
    const entries = new Map<string, ScanEntry<T>>();

    return {
        share(key, run) {
            const at = now();

            for (const [old, entry] of entries) {
                if (entry.settledAt !== null && at - entry.settledAt > ttlMs) {
                    entries.delete(old);
                }
            }

            const hit = entries.get(key);

            if (hit) {
                return hit.promise;
            }

            const entry: ScanEntry<T> = { promise: run(), settledAt: null };
            entries.set(key, entry);

            void entry.promise.then(
                () => {
                    entry.settledAt = now();
                },
                () => {
                    // Only ever remove OUR entry: a scan that fails after its key was
                    // reused would otherwise delete a healthy replacement.
                    if (entries.get(key) === entry) {
                        entries.delete(key);
                    }
                }
            );

            return entry.promise;
        },

        size() {
            return entries.size;
        },
    };
}

/** A month of transcripts takes about 20s. Past a minute, something is wrong rather than slow. */
const TRANSCRIPT_SCAN_TIMEOUT_MS = 60_000;

const TRANSCRIPT_SCAN_WORKER = new URL("./transcript-scan-worker.ts", import.meta.url);

/** Points per limit series a response may carry before it is downsampled. */
const MAX_SERIES_POINTS = 600;

/**
 * A `step` for `UsageLimitsDb.getSeries` when the caller named none, so the
 * response cannot grow without bound as the window widens. A 30-day window
 * already sits under the cap, so this changes nothing a reader can see today; it
 * exists so a 6-month custom range does not return a megabyte of JSON.
 */
export function defaultSeriesStep(from: string, to: string): number | undefined {
    const span = Date.parse(to) - Date.parse(from);

    if (!Number.isFinite(span) || span <= 0) {
        return undefined;
    }

    return Math.max(1, Math.floor(span / MAX_SERIES_POINTS));
}

export function createAiAggregator(): AiAggregator {
    registerBuiltInPlugins();

    async function enabledAccounts(): Promise<AccountEntry[]> {
        const store = await AiConfigStore.load();
        const wanted = accountProviderIds();

        return store.accounts().filter((account) => wanted.has(account.provider));
    }

    async function accountsById(): Promise<Map<string, AccountEntry>> {
        const store = await AiConfigStore.load();
        return new Map(store.accounts().map((account) => [account.id, account]));
    }

    async function readCurrent(): Promise<AiUsageResult> {
        return flattenSnapshotsCache(await readSnapshotsCache());
    }

    /**
     * Account NAMES the limits DB should be asked about. The DB is keyed by name;
     * the dashboard filters by id, so config is what translates between them.
     * `null` means "no filter was given, ask for everything".
     */
    function seriesAccountNames(accounts: readonly AccountEntry[], query: UsageSeriesQuery): string[] | null {
        const providers = query.providers?.length ? new Set(query.providers.map(resolveProviderFilter)) : undefined;
        const wanted = query.accounts?.length ? new Set(query.accounts) : undefined;

        if (!providers && !wanted) {
            return null;
        }

        return accounts
            .filter((account) => !providers || providers.has(account.provider))
            .filter((account) => !wanted || wanted.has(account.id) || wanted.has(account.name))
            .map((account) => account.name);
    }

    /** The spend stores filter by account id, so the provider chips become ids first. */
    async function scopedAccountIds(query: SpendTotalsQuery): Promise<readonly string[] | undefined> {
        if (!query.providers?.length) {
            return query.accounts?.length ? [...query.accounts] : undefined;
        }

        return spendAccountIds(query, await enabledAccounts());
    }

    function emptyTotals(query: SpendTotalsQuery): AiSpendTotalsResult {
        return {
            from: query.from,
            to: query.to,
            source: query.source,
            total: emptyBucket(),
            accounts: [],
            unpriced: 0,
        };
    }

    function spendFromCalls(query: SpendTotalsQuery, grain?: SpendGrain) {
        return queryUsage({
            from: query.from,
            to: query.to,
            ...(query.accounts?.length ? { accountId: [...query.accounts] } : {}),
            ...(grain ? { grain, byModel: true } : {}),
        });
    }

    const transcriptScans = createScanCache<SpendSeriesResult>(TRANSCRIPT_SCAN_TTL_MS);

    async function runTranscriptScan(query: SpendTotalsQuery): Promise<SpendSeriesResult> {
        const output = await callWorker<TranscriptScanInput, TranscriptScanOutput>(
            TRANSCRIPT_SCAN_WORKER,
            {
                from: query.from,
                to: query.to,
                grain: TRANSCRIPT_SCAN_GRAIN,
                ...(query.accounts?.length ? { accountIds: [...query.accounts] } : {}),
                accounts: await enabledAccounts(),
            },
            { timeoutMs: TRANSCRIPT_SCAN_TIMEOUT_MS, label: "transcript spend scan" }
        );

        if (!output.ok) {
            throw new Error(output.error);
        }

        return output.result;
    }

    /**
     * The transcript scan is synchronous and walks every session log, so a second
     * identical one blocks the whole server for as long again. Callers share the
     * in-flight promise; the result is read-only to both.
     */
    function spendFromTranscripts(query: SpendTotalsQuery) {
        const key = transcriptScanKey(query);

        return transcriptScans.share(key, () => {
            logger.debug({ key }, "[ai-dashboard] transcript scan started");
            const scan = runTranscriptScan(query);

            void scan.catch((err: unknown) => {
                logger.debug({ err, key }, "[ai-dashboard] transcript scan failed, not cached");
            });

            return scan;
        });
    }

    return {
        async listAccounts(): Promise<AiAccountsResult> {
            const features = featuresByPlugin();
            const accounts: AiAccountListItem[] = (await enabledAccounts()).map((account) => {
                const plugin = features.get(account.provider);

                return {
                    id: account.id,
                    name: account.name,
                    provider: account.provider,
                    alias: providerAliasOf(account.provider),
                    label: account.label,
                    enabled: account.enabled,
                    hasUsage: plugin?.usage !== undefined,
                    hasSpendScope: plugin?.spendScope !== undefined,
                    credentialKinds: credentialKindsOf(account),
                };
            });

            const providers: AiProviderPresentation[] = [...features.entries()].map(([provider, plugin]) => ({
                provider,
                prominentLimits: [...plugin.presentation.prominentLimits],
            }));

            logger.debug({ accounts: accounts.length, providers: providers.length }, "[ai-dashboard] account list");
            return { accounts, providers };
        },

        async getCurrentSnapshots(filter: SnapshotFilter): Promise<AiUsageResult> {
            const current = await readCurrent();
            return { fetchedAt: current.fetchedAt, snapshots: filterSnapshots(current.snapshots, filter) };
        },

        async refreshSnapshots(filter: SnapshotFilter): Promise<AiUsageResult> {
            // Poll every provider, not just the filtered ones: the cache file and the
            // SSE frame are whole-world documents, and a filtered write would blank
            // out the providers this request happened not to ask about.
            await pollAccounts({ force: true });
            const current = await readCurrent();
            publishAiUsage(getLiveHub(), current);

            return { fetchedAt: current.fetchedAt, snapshots: filterSnapshots(current.snapshots, filter) };
        },

        async getUsageSeries(query: UsageSeriesQuery): Promise<AiUsageSeriesResult> {
            const accounts = await enabledAccounts();
            const names = seriesAccountNames(accounts, query);

            if (names !== null && names.length === 0) {
                return { series: [] };
            }

            const current = await readCurrent();
            const labels = new Map(
                current.snapshots.flatMap((snapshot) =>
                    snapshot.limits.map(
                        (limit) =>
                            [
                                `${providerAccountKey(snapshot.provider, snapshot.accountName)}|${limit.key}`,
                                limit.label,
                            ] as const
                    )
                )
            );
            const db = new UsageLimitsDb();
            const step = query.step ?? defaultSeriesStep(query.from, query.to);
            const entries = db.getSeries({
                ...(names ? { accounts: names } : {}),
                ...(query.keys?.length ? { keys: [...query.keys] } : {}),
                from: query.from,
                to: query.to,
                ...(step !== undefined ? { step } : {}),
            });

            // The DB narrows by account NAME only, so the provider filter is applied
            // again over the rows it returned; each row keeps the provider it was
            // written under rather than borrowing one from a same-named account.
            const series: LimitSeries[] = limitSeriesFrom(entries, accounts, labels, query);

            logger.debug({ series: series.length, from: query.from, to: query.to }, "[ai-dashboard] limit series");
            return { series };
        },

        async getSpendTotals(request: SpendTotalsQuery): Promise<AiSpendTotalsResult> {
            const accountIds = await scopedAccountIds(request);

            if (accountIds && accountIds.length === 0) {
                return emptyTotals(request);
            }

            const query: SpendTotalsQuery = { ...request, accounts: accountIds };
            const byId = await accountsById();
            const total = emptyBucket();
            const perAccount = new Map<string, SpendBucket>();
            let unpriced = 0;

            if (query.source !== "transcripts") {
                const calls = spendFromCalls(query);
                total.costUsd += calls.total.costUsd;
                total.tokens += calls.total.inputTokens + calls.total.outputTokens;
                unpriced += calls.total.unpricedEvents;

                for (const [accountId, aggregate] of Object.entries(calls.byAccount)) {
                    const bucket = perAccount.get(accountId) ?? emptyBucket();
                    addBucket(bucket, {
                        costUsd: aggregate.costUsd,
                        tokens: aggregate.inputTokens + aggregate.outputTokens,
                    });
                    perAccount.set(accountId, bucket);
                }
            }

            if (query.source !== "calls") {
                // Totals sums every bucket, so the axis the scan used cannot change
                // this answer. It asks for no grain at all, which is what lets it
                // share the series' scan whatever the series asked for.
                const transcripts = await spendFromTranscripts(query);
                unpriced += transcripts.unpriced;

                for (const point of transcripts.points) {
                    total.costUsd += point.costUsd;
                    total.tokens += point.tokens;

                    for (const [accountId, bucket] of Object.entries(point.byAccount)) {
                        const existing = perAccount.get(accountId) ?? emptyBucket();
                        addBucket(existing, bucket);
                        perAccount.set(accountId, existing);
                    }
                }
            }

            const accounts: SpendAccountTotals[] = [...perAccount.entries()]
                .map(([accountId, bucket]) => ({ ...refFor(accountId, byId), ...bucket }))
                .sort((a, b) => b.costUsd - a.costUsd || a.accountName.localeCompare(b.accountName));

            return { from: query.from, to: query.to, source: query.source, total, accounts, unpriced };
        },

        async getSpendSeries(request: SpendSeriesQuery): Promise<AiSpendSeriesResult> {
            const grain = effectiveSpendGrain(request.source, request.grain);
            const accountIds = await scopedAccountIds(request);

            if (accountIds && accountIds.length === 0) {
                return {
                    from: request.from,
                    to: request.to,
                    grain,
                    source: request.source,
                    points: [],
                    accounts: [],
                    unpriced: 0,
                };
            }

            const query: SpendSeriesQuery = { ...request, accounts: accountIds, grain };
            const byId = await accountsById();
            let points: SpendSeriesPoint[] = [];
            const refs: AccountRef[] = [];
            let unpriced = 0;

            if (query.source !== "transcripts") {
                const calls = spendFromCalls(query, grain);
                points = calls.points ?? [];
                unpriced += calls.total.unpricedEvents;
                refs.push(...Object.keys(calls.byAccount).map((accountId) => refFor(accountId, byId)));
            }

            if (query.source !== "calls") {
                const transcripts = await spendFromTranscripts(query);
                points = mergePoints(points, foldSpendPoints(transcripts.points, grain));
                unpriced += transcripts.unpriced;
                refs.push(...transcripts.accounts);
            }

            return {
                from: query.from,
                to: query.to,
                grain,
                source: query.source,
                points,
                accounts: dedupeRefs(refs),
                unpriced,
            };
        },

        async getAiDaemonStatus(): Promise<AiDaemonStatus> {
            // `getTask` reads the daemon config; `isTaskRegistered` would also
            // create the storage dirs, which a diagnostic must not do.
            const task = await getTask(USAGE_TASK_NAME);
            const lastRun = getRecentRuns({ task: USAGE_TASK_NAME, limit: 1 })[0];
            const current = await readSnapshotsCache();
            const now = Date.now();
            const perProvider: Record<string, AiDaemonProviderStatus> = {};

            for (const [pluginId, slice] of Object.entries(current?.providers ?? {})) {
                const stamps = slice.accounts
                    .map((account) => Date.parse(account.fetchedAt))
                    .filter((ms) => !Number.isNaN(ms));
                const lastFetch = stamps.length > 0 ? Math.max(...stamps) : undefined;

                perProvider[pluginId] = {
                    ...(lastFetch !== undefined
                        ? {
                              lastFetchAt: new Date(lastFetch).toISOString(),
                              ageSec: Math.round((now - lastFetch) / 1000),
                          }
                        : {}),
                    ...(slice.accounts.find((account) => account.error)?.error
                        ? { error: slice.accounts.find((account) => account.error)?.error }
                        : {}),
                };
            }

            let nextRunAt: string | undefined;

            if (task && lastRun) {
                try {
                    nextRunAt = computeNextRunAt(parseInterval(task.every), new Date(lastRun.startedAt)).toISOString();
                } catch (err) {
                    logger.debug({ err, every: task.every }, "[ai-dashboard] unparseable daemon interval");
                }
            }

            return {
                registered: task !== undefined,
                taskName: USAGE_TASK_NAME,
                ...(lastRun ? { lastRunAt: lastRun.startedAt } : {}),
                ...(nextRunAt ? { nextRunAt } : {}),
                perProvider,
            };
        },

        async registerAiDaemon(): Promise<{ ok: boolean }> {
            const result = await registerUsagePollTask({
                interval: "every 30 seconds",
                maxAgeDays: 3,
                minRuns: 100,
            });

            logger.info({ ...result, task: USAGE_TASK_NAME }, "[ai-dashboard] usage poll task registered");
            return { ok: result.created };
        },
    };
}

let instance: AiAggregator | null = null;

export function defaultAiAggregator(): AiAggregator {
    if (!instance) {
        instance = createAiAggregator();
    }

    return instance;
}
