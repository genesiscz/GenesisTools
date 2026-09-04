import { snapshotToAccountUsage, toLimitWindows } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/usage";
import { pollAccounts } from "@genesiscz/utils/ai/usage-poll/poll";
import { recordSnapshots } from "@genesiscz/utils/ai/usage-poll/record";
import type { Cached, SharedUsageOpts } from "@genesiscz/utils/ai/usage-poll/shared-cache";
import { snapshotsCacheKey, USAGE_CACHE_TTL, usagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";
import { logger } from "@genesiscz/utils/logger";
import type { AccountUsage } from "./api";

export {
    __makeSharedUsage,
    API_MIN_INTERVAL_MS,
    type Cached,
    DB_FRESH_MS,
    type SharedUsageOpts,
} from "@genesiscz/utils/ai/usage-poll/shared-cache";

/**
 * The claude-only door onto the provider-neutral poll core.
 *
 * `anthropic-sub` now declares `accounts.usage`, so `pollAccounts` owns the 45s cache, the
 * failure gate, the history write-through and the legacy `usage-shared` projection for
 * every provider at once. This file is what keeps the callers that still speak
 * `AccountUsage` — `tools claude start`, the doctor, `watch`, the dev-dashboard aggregator
 * — working without each of them learning the snapshot shape.
 *
 * There is no second fetch path any more: the cache key `snapshots:anthropic-sub` holds
 * `AccountUsageSnapshot` rows, and everything below is a projection of them.
 */

const PROVIDER = "anthropic-sub";
const CACHE_KEY = snapshotsCacheKey(PROVIDER);
const storage = usagePollStorage();

function toAccountFilter(filter: SharedUsageOpts["accountFilter"]): string[] | undefined {
    if (filter === undefined) {
        return undefined;
    }

    return Array.isArray(filter) ? filter : [filter];
}

export async function getSharedAccountsUsage(opts: SharedUsageOpts = {}): Promise<AccountUsage[]> {
    const accountFilter = toAccountFilter(opts.accountFilter);
    const snapshots = await pollAccounts({
        providers: [PROVIDER],
        ...(accountFilter === undefined ? {} : { accountFilter }),
        ...(opts.force === undefined ? {} : { force: opts.force }),
        ...(opts.maxStaleMs === undefined ? {} : { maxStaleMs: opts.maxStaleMs }),
    });

    return snapshots.map(snapshotToAccountUsage);
}

/**
 * Write fetched usage to the limits store. The poll core already does this on every live
 * fetch; the export survives for callers that hold `AccountUsage` rows from somewhere else
 * (`usage-mirror.test.ts` pins the mirror contract through it).
 *
 * Stale rows are skipped: recording them would re-timestamp old utilization as current.
 */
export async function recordAll(accounts: AccountUsage[]): Promise<void> {
    const snapshots: AccountUsageSnapshot[] = [];

    for (const account of accounts) {
        if (!account.usage || account.stale) {
            continue;
        }

        snapshots.push({
            provider: PROVIDER,
            accountId: "",
            accountName: account.accountName,
            fetchedAt: new Date().toISOString(),
            limits: toLimitWindows(account.usage),
            native: account.usage,
        });
    }

    await recordSnapshots(snapshots);
}

/**
 * Drop the shared cache so the next read rebuilds it. Needed after anything that changes
 * what an account is CALLED, since every entry is name-keyed and a stale entry would
 * render as a ghost row under the old name.
 */
export async function invalidateSharedUsage(): Promise<void> {
    await storage.putCacheFile(CACHE_KEY, { fetchedAt: 0, accounts: [] }, USAGE_CACHE_TTL);
    logger.debug("[usage] shared cache invalidated");
}

/** Read the last cached payload WITHOUT ever triggering a fetch. */
export async function peekSharedUsage(): Promise<Cached<AccountUsage> | null> {
    const cached = await storage.getCacheFile<Cached<AccountUsageSnapshot>>(CACHE_KEY, USAGE_CACHE_TTL);

    if (!cached) {
        return null;
    }

    return { fetchedAt: cached.fetchedAt, accounts: cached.accounts.map(snapshotToAccountUsage) };
}
