import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { showsInUsageDashboard } from "@genesiscz/utils/ai/config/selectors";
import type { AccountFeatures, AccountUsageFeature } from "@genesiscz/utils/ai/providers/account-features";
import { resolveProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { pluginsWithUsage } from "@genesiscz/utils/ai/providers/registry";
import { logger } from "@genesiscz/utils/logger";
import type { SnapshotsCacheProvider } from "./legacy-cache";
import { projectRoundIntoLegacyCache, readSnapshotsCache, writeSnapshotsCache } from "./legacy-cache";
import {
    applyPollGateOutcomes,
    blockedEntry,
    isTransportFailure,
    loadPollGate,
    PollSuppressed,
    pruneGate,
} from "./poll-gate";
import { recordSnapshots } from "./record";
import type { Cached } from "./shared-cache";
import { __makeSharedUsage, API_MIN_INTERVAL_MS, SNAPSHOT_OPS } from "./shared-cache";
import { snapshotsCacheKey, USAGE_CACHE_TTL, usageCacheFilePath, usagePollStorage } from "./storage";
import type { AccountUsageSnapshot } from "./types";

export interface UsagePlugin {
    plugin: ProviderPlugin;
    features: AccountFeatures;
    usage: AccountUsageFeature;
}

/**
 * Every provider that reports live quota, with its optional members narrowed so callers
 * can read `entry.usage` without a guard per line.
 *
 * 🛑 `registerBuiltInPlugins()` is called HERE, not left to the caller. The registry is
 * per-process and starts empty, so a fresh process that only imports the poll core —
 * the launchd `ai-usage-poll` daemon, the dev-dashboard producer — read an empty registry
 * and silently polled nothing, with no error to notice. `tools ai usage` happened to work
 * only because registering the `config` commands registers the plugins as a side effect.
 * The call is idempotent, so doing it at the one place that reads the registry costs
 * nothing and cannot be forgotten by the next caller.
 */
export function usagePlugins(): UsagePlugin[] {
    registerBuiltInPlugins();
    const out: UsagePlugin[] = [];

    for (const plugin of pluginsWithUsage()) {
        const features = plugin.accounts;

        if (features?.usage) {
            out.push({ plugin, features, usage: features.usage });
        }
    }

    return out;
}

export interface PollAccountsOptions {
    /** Plugin ids or CLI aliases (`claude`, `codex`, `grok`). Omitted means every provider. */
    providers?: string[];
    /** Account names. Omitted means every visible account. */
    accountFilter?: string[];
    /** Bypass the shared cache. */
    force?: boolean;
    /** Diagnosis only: never rotate or spend a single-use credential. */
    probe?: boolean;
    /** Override the shared-cache freshness window. Defaults to the provider's own floor. */
    maxStaleMs?: number;
}

/**
 * Poll every provider that declares `accounts.usage`, returning one snapshot per visible
 * account (spec 2026-09-04 section 6.1). Each provider has its own 45s cache, file lock and
 * failure gate, so a slow codex app-server never delays an anthropic refresh.
 */
export async function pollAccounts(opts: PollAccountsOptions = {}): Promise<AccountUsageSnapshot[]> {
    const wanted = opts.providers?.map((p) => resolveProviderAlias(p));
    const plugins = usagePlugins().filter((entry) => !wanted || wanted.includes(entry.plugin.id));

    if (plugins.length === 0) {
        logger.debug({ providers: opts.providers }, "[usage] no provider plugin declares accounts.usage");
        return [];
    }

    const store = await AiConfigStore.load();
    const results = await Promise.all(plugins.map((entry) => pollProvider(entry, store.accounts(), opts)));
    // A filtered poll knows about its own accounts only. The writer merges per PROVIDER,
    // which does not help inside the slice being replaced, so the accounts this round
    // never asked about are carried over from the file itself.
    const existing = opts.accountFilter ? await readSnapshotsCache() : null;
    const out: AccountUsageSnapshot[] = [];
    const byProvider: Record<string, SnapshotsCacheProvider> = {};

    for (let i = 0; i < plugins.length; i++) {
        const { plugin, features } = plugins[i];
        out.push(...results[i]);
        byProvider[plugin.id] = {
            alias: features.presentation.alias,
            displayName: features.presentation.displayName,
            prominent: [...features.presentation.prominentLimits],
            accounts: mergeAccountSlice(existing?.providers[plugin.id]?.accounts, results[i]),
        };
    }

    // The all-provider file is what Plan-Dashboard and the Genesis app read. The writer
    // merges per provider, so a call that polled one provider never drops the others.
    await writeSnapshotsCache(byProvider, latestFetchedAt(out));

    return out;
}

/** Fresh rows first, then the accounts the previous file held that this round skipped. */

/**
 * When the rows this round returned were actually fetched.
 *
 * `pollAccounts` runs on every READ, and most reads are served from the 45s cache, so
 * stamping the file with `Date.now()` told the dashboard and the Genesis app that a
 * minutes-old reading had just arrived. Every snapshot carries its own fetch time; the
 * newest of them is the one fact the file-level stamp can honestly report.
 */
export function latestFetchedAt(snapshots: readonly AccountUsageSnapshot[], now: Date = new Date()): Date {
    let newest = 0;

    for (const snapshot of snapshots) {
        const ms = Date.parse(snapshot.fetchedAt);

        if (Number.isFinite(ms) && ms > newest) {
            newest = ms;
        }
    }

    return newest > 0 ? new Date(newest) : now;
}
export function mergeAccountSlice(
    previous: readonly AccountUsageSnapshot[] | undefined,
    fresh: AccountUsageSnapshot[]
): AccountUsageSnapshot[] {
    if (!previous || previous.length === 0) {
        return fresh;
    }

    const fetched = new Set(fresh.map((snapshot) => snapshot.accountName));

    return [...fresh, ...previous.filter((snapshot) => !fetched.has(snapshot.accountName))];
}

function visibleAccounts(all: readonly AccountEntry[], providerId: string, filter?: string[]): AccountEntry[] {
    const names = filter ? new Set(filter) : undefined;

    return all.filter(
        (account) =>
            account.provider === providerId && showsInUsageDashboard(account) && (!names || names.has(account.name))
    );
}

async function pollProvider(
    entry: UsagePlugin,
    allAccounts: readonly AccountEntry[],
    opts: PollAccountsOptions
): Promise<AccountUsageSnapshot[]> {
    const providerId = entry.plugin.id;
    const accounts = visibleAccounts(allAccounts, providerId, opts.accountFilter);

    if (accounts.length === 0) {
        return [];
    }

    const storage = usagePollStorage();
    const cacheKey = snapshotsCacheKey(providerId);
    const getShared = __makeSharedUsage<AccountUsageSnapshot>({
        provider: providerId,
        ops: SNAPSHOT_OPS,
        fetchAll: ({ orgBlocked }) => fetchProviderSnapshots(entry, accounts, opts, orgBlocked),
        getCache: async (key) =>
            (await storage.getCacheFile<Cached<AccountUsageSnapshot>>(key, USAGE_CACHE_TTL)) ?? null,
        putCache: (key, value) => storage.putCacheFile(key, value, USAGE_CACHE_TTL),
        withLock: (key, fn) => storage.withFileLock({ file: usageCacheFilePath(key), fn, timeout: 10_000 }),
        recordHistory: (snapshots) => recordSnapshots(snapshots),
        // Spec 6.4: the Genesis app still reads `claude-usage/cache/usage-shared` directly,
        // so an anthropic round keeps writing it until Genesis switches to snapshots.json.
        onFresh: (snapshots, fetchedAt) => projectRoundIntoLegacyCache(providerId, snapshots, fetchedAt),
    });

    logger.debug({ provider: providerId, accounts: accounts.length, cacheKey }, "[usage] polling provider");

    return getShared({
        force: opts.force,
        accountFilter: opts.accountFilter,
        maxStaleMs: opts.maxStaleMs ?? Math.max(API_MIN_INTERVAL_MS, entry.usage.minIntervalMs ?? 0),
    });
}

/**
 * One live round for one provider: the failure gate decides who is polled at all, the
 * plugin does the fetching, and the gate is updated from the outcomes. Modelled on
 * `fetchAllAccountsUsage` (`src/claude/lib/usage/api.ts`), which stays the anthropic path.
 */
async function fetchProviderSnapshots(
    entry: UsagePlugin,
    accounts: readonly AccountEntry[],
    opts: PollAccountsOptions,
    orgBlocked: ReadonlySet<string>
): Promise<AccountUsageSnapshot[]> {
    const providerId = entry.plugin.id;
    const now = Date.now();
    const stored = await loadPollGate(providerId);
    // Pruning is only safe on an UNFILTERED poll: a filtered one knows nothing about the
    // accounts it excluded and would wipe their backoff.
    const gate = opts.accountFilter
        ? stored
        : pruneGate(
              stored,
              accounts.map((a) => a.name)
          );
    let gateDirty = Object.keys(gate).length !== Object.keys(stored).length;

    const settled = await Promise.allSettled(
        accounts.map((account) => {
            const blocked = blockedEntry(gate, account.name, now);

            if (blocked) {
                return Promise.reject(new PollSuppressed(blocked.reason));
            }

            return entry.usage.poll(account, { probe: opts.probe, force: opts.force, orgBlocked });
        })
    );

    const successes: string[] = [];
    const failures: Array<{ account: string; reason: string; transport?: boolean }> = [];

    const snapshots = settled.map((result, i) => {
        const account = accounts[i];

        if (result.status === "fulfilled") {
            if (gate[account.name]) {
                successes.push(account.name);
                gateDirty = true;
            }

            return result.value;
        }

        const suppressed = result.reason instanceof PollSuppressed;
        const reason = suppressed ? result.reason.message : String(result.reason);

        if (suppressed) {
            logger.debug({ provider: providerId, account: account.name, reason }, "[usage] account not polled");
        } else {
            failures.push({ account: account.name, reason, transport: isTransportFailure(result.reason) });
            gateDirty = true;
            logger.warn({ provider: providerId, account: account.name, reason }, "[usage] poll failed");
        }

        return {
            provider: providerId,
            accountId: account.id,
            accountName: account.name,
            label: account.label,
            fetchedAt: new Date(now).toISOString(),
            limits: [],
            error: reason,
        } satisfies AccountUsageSnapshot;
    });

    if (gateDirty) {
        await applyPollGateOutcomes({
            provider: providerId,
            successes,
            failures,
            now,
            knownAccounts: opts.accountFilter ? undefined : accounts.map((a) => a.name),
        });
    }

    return snapshots;
}
