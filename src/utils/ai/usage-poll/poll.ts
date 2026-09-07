import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { showsInUsageDashboard } from "@genesiscz/utils/ai/config/selectors";
import type {
    AccountFeatures,
    AccountUsageFeature,
    UsageFailureClass,
} from "@genesiscz/utils/ai/providers/account-features";
import { resolveProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { pluginsWithUsage } from "@genesiscz/utils/ai/providers/registry";
import { logger } from "@genesiscz/utils/logger";
import type { SnapshotsCacheProvider } from "./legacy-cache";
import { projectRoundIntoLegacyCache, writeSnapshotsCache } from "./legacy-cache";
import {
    applyPollGateOutcomes,
    blockedEntry,
    credentialMovedSince,
    failureStreak,
    type GateEntry,
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
    const out: AccountUsageSnapshot[] = [];
    const byProvider: Record<string, SnapshotsCacheProvider> = {};

    for (let i = 0; i < plugins.length; i++) {
        const { plugin, features } = plugins[i];
        out.push(...results[i]);
        byProvider[plugin.id] = {
            alias: features.presentation.alias,
            displayName: features.presentation.displayName,
            prominent: [...features.presentation.prominentLimits],
            accounts: results[i],
        };
    }

    // The all-provider file is what Plan-Dashboard and the Genesis app read. The writer
    // merges per provider, so a call that polled one provider never drops the others. A
    // FILTERED round also merges inside its own slice, under the same lock: doing it out
    // here against a pre-lock read let two same-provider rounds overwrite each other.
    await writeSnapshotsCache(byProvider, latestFetchedAt(out), { mergeAccounts: opts.accountFilter !== undefined });

    return out;
}

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
        fetchAll: ({ orgBlocked }) => __fetchProviderSnapshots(entry, accounts, opts, orgBlocked),
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
        // The RESOLVED names, not the caller's raw list: a filter may name accounts of
        // another provider, and the cache's coverage check counts what it was asked for.
        ...(opts.accountFilter === undefined ? {} : { accountFilter: accounts.map((a) => a.name) }),
        maxStaleMs: opts.maxStaleMs ?? Math.max(API_MIN_INTERVAL_MS, entry.usage.minIntervalMs ?? 0),
        // Survives `force`: a codex poll spawns an app-server and a grok poll costs a
        // vendor request, so the every-30s daemon must not drive either on every tick.
        floorMs: entry.usage.minIntervalMs ?? 0,
    });
}

/**
 * One live round for one provider: the failure gate decides who is polled at all, the
 * plugin does the fetching, and the gate is updated from the outcomes. Modelled on
 * `fetchAllAccountsUsage` (`src/claude/lib/usage/api.ts`), which stays the anthropic path.
 *
 * Exported under `__` for the gate tests, which drive it with a fake plugin against a
 * temporary `GENESIS_TOOLS_HOME`: everything that decides whether an account is polled,
 * suppressed or blocked lives here and nowhere else.
 */
/**
 * The row the core writes for an account whose poll threw.
 *
 * `failure` is the plugin's own reading of the error, and `auth.orgBlocked` is the only
 * place `SNAPSHOT_OPS.orgBlocked` looks. An org-level 403 that stayed a bare error string
 * left the next round's `orgBlocked` set empty, so a following 401 or 429 for the same
 * dead organization reached the force-refresh that spends a single-use grant (review t7).
 *
 * `holding` is the gate entry that suppressed this account, when one did. It turns the row
 * from a bare replayed error into "blocked until X after N failures", which is the only
 * thing on screen that says no request was made this round.
 */
export function failureSnapshot(args: {
    provider: string;
    account: Pick<AccountEntry, "id" | "name" | "label">;
    reason: string;
    now: number;
    failure?: UsageFailureClass | undefined;
    holding?: GateEntry | undefined;
}): AccountUsageSnapshot {
    return {
        provider: args.provider,
        accountId: args.account.id,
        accountName: args.account.name,
        label: args.account.label,
        fetchedAt: new Date(args.now).toISOString(),
        limits: [],
        error: args.reason,
        ...(args.failure?.orgBlocked ? { auth: { orgBlocked: true } } : {}),
        ...(args.holding
            ? {
                  blocked: {
                      until: new Date(args.holding.blockedUntil).toISOString(),
                      failures: failureStreak(args.holding),
                  },
              }
            : {}),
    };
}

/**
 * When each account's credential was last written, for the plugins that can say. Failing to
 * stat one is not a poll failure: an unknown stamp only means the gate cannot tell that a
 * re-login happened, which is where it started.
 */
async function credentialStamps(entry: UsagePlugin, accounts: readonly AccountEntry[]): Promise<Map<string, number>> {
    const stamp = entry.usage.credentialStamp;
    const stamps = new Map<string, number>();

    if (!stamp) {
        return stamps;
    }

    await Promise.all(
        accounts.map(async (account) => {
            const value = await stamp(account);

            if (typeof value === "number" && Number.isFinite(value)) {
                stamps.set(account.name, value);
            }
        })
    );

    return stamps;
}

export async function __fetchProviderSnapshots(
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
    const stamps = await credentialStamps(entry, accounts);
    // Accounts whose credential was rewritten after the failure that blocked them: the
    // user re-logged in through the vendor CLI, which we cannot hook. Their entry is
    // dropped so the ladder starts from zero, exactly as `tools claude login` does for
    // anthropic — a repaired account must not inherit the streak the dead one earned.
    const released: string[] = [];
    // The entry that suppressed each account, so the snapshot can say how long the pause
    // lasts and how many failures bought it. A plan-level suppression has no entry here.
    const blockedBy = new Map<string, GateEntry>();

    const settled = await Promise.allSettled(
        accounts.map((account) => {
            const stamp = stamps.get(account.name);

            if (credentialMovedSince(gate[account.name], stamp)) {
                released.push(account.name);
                gateDirty = true;
                logger.info(
                    { provider: providerId, account: account.name },
                    "[usage] credential was rewritten since the failure; releasing the poll gate"
                );
            }

            const blocked = blockedEntry(gate, account.name, now, stamp);

            if (blocked) {
                blockedBy.set(account.name, blocked);
                return Promise.reject(new PollSuppressed(blocked.reason));
            }

            return entry.usage.poll(account, { probe: opts.probe, force: opts.force, orgBlocked });
        })
    );

    const successes: string[] = [...released];
    const failures: Array<{ account: string; reason: string; transport?: boolean }> = [];

    const snapshots = settled.map((result, i) => {
        const account = accounts[i];

        if (result.status === "fulfilled") {
            // A plugin may REPORT a failure instead of throwing it: codex answers a
            // logged-out home with an error row rather than an exception. Counting that
            // as a success cleared the backoff it should have earned, so the account
            // spawned an app-server every two minutes forever and never earned a pause.
            const reported = result.value.error;

            if (reported !== undefined) {
                failures.push({ account: account.name, reason: reported, transport: isTransportFailure(reported) });
                gateDirty = true;
                logger.warn(
                    { provider: providerId, account: account.name, reason: reported },
                    "[usage] poll reported a failure"
                );

                return result.value;
            }

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

        return failureSnapshot({
            provider: providerId,
            account,
            reason,
            now,
            ...(suppressed ? {} : { failure: entry.usage.classifyFailure?.(result.reason) }),
            holding: blockedBy.get(account.name),
        });
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
