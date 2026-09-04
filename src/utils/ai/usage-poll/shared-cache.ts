import { logger } from "@genesiscz/utils/logger";
import type { AccountUsageSnapshot } from "./types";

export const DB_FRESH_MS = 10_000;
/**
 * How old a cached fetch may be before a READING consumer fetches for itself.
 * Deliberately longer than the daemon's 30s poll period: the daemon is the
 * single driver, and a window shorter than its period makes every other
 * consumer race it into a duplicate poll (at 30s/60s, roughly every second
 * `tools claude start` fetched all accounts itself and printed the failures
 * into its own picker).
 */
export const API_MIN_INTERVAL_MS = 45_000;

export interface Cached<T> {
    fetchedAt: number;
    accounts: T[];
}

/** How the generic accessor reads and rewrites one provider's account entries. */
export interface UsageEntryOps<T> {
    nameOf(entry: T): string;
    /** True when the entry carries real data rather than only an error row. */
    hasData(entry: T): boolean;
    errorOf(entry: T): string | undefined;
    /** True when the data attached to this entry is a replay of an older successful fetch. */
    isStale(entry: T): boolean;
    /** Copy last-good data from `previous` onto a failed `entry` and mark it stale. */
    backfill(entry: T, previous: T, previousFetchedAt: number): T;
    /** Mark an entry that already carries data as stale, without changing the data. */
    markStale(entry: T, reason: string, fetchedAt: number): T;
    /** Accounts the provider has blocked at the org level in a previous payload. */
    orgBlocked(entries: readonly T[] | undefined): ReadonlySet<string>;
}

export interface SharedUsageDeps<T> {
    /** Plugin id. Decides the cache key, the lock file and the gate file. */
    provider: string;
    ops: UsageEntryOps<T>;
    fetchAll: (opts: { accountFilter?: string | string[]; orgBlocked: ReadonlySet<string> }) => Promise<T[]>;
    getCache: (key: string) => (Cached<T> | null) | Promise<Cached<T> | null>;
    putCache: (key: string, value: Cached<T>) => void | Promise<void>;
    withLock: <R>(key: string, fn: () => Promise<R>) => Promise<R>;
    notifyExtraUsage?: (accounts: T[]) => void | Promise<void>;
    recordHistory?: (accounts: T[]) => void | Promise<void>;
    /** Ran after every LIVE fetch, with the whole payload. Used for the legacy projection. */
    onFresh?: (accounts: T[], fetchedAt: number) => void | Promise<void>;
}

export interface SharedUsageOpts {
    accountFilter?: string | string[];
    force?: boolean;
    /** Serve cache if a successful fetch happened within this many ms. Default API_MIN_INTERVAL_MS. */
    maxStaleMs?: number;
}

function filterAccounts<T>(ops: UsageEntryOps<T>, accounts: T[], filter?: string | string[]): T[] {
    if (filter === undefined) {
        return accounts;
    }

    const set = new Set(Array.isArray(filter) ? filter : [filter]);
    return accounts.filter((a) => set.has(ops.nameOf(a)));
}

/**
 * Backfill accounts whose live fetch failed with the last-good payload from the
 * previous cache entry, marked `stale` so consumers can render the data with an
 * age indicator and writers can skip it. Chained failures keep the ORIGINAL
 * success timestamp (the previous entry's own `stale.lastSuccessAt` wins over
 * the cache write time), which `ops.backfill` is responsible for.
 */
function backfillFromLastGood<T>(ops: UsageEntryOps<T>, fresh: T[], prev: Cached<T> | null): T[] {
    if (!prev) {
        return fresh;
    }

    return fresh.map((account) => {
        if (ops.hasData(account) || !ops.errorOf(account)) {
            return account;
        }

        const previous = prev.accounts.find((p) => ops.nameOf(p) === ops.nameOf(account));

        if (!previous || !ops.hasData(previous)) {
            return account;
        }

        return ops.backfill(account, previous, prev.fetchedAt);
    });
}

/** Mark every data-bearing account in a cache entry stale with the given reason. */
function markAllStale<T>(ops: UsageEntryOps<T>, entry: Cached<T>, reason: string): T[] {
    return entry.accounts.map((account) => {
        if (!ops.hasData(account)) {
            return account;
        }

        return ops.markStale(account, reason, entry.fetchedAt);
    });
}

/**
 * The shared 45s cache, once, parameterised by provider (spec section 6.3). Exported for
 * tests, and used by every provider's live accessor through injected dependencies.
 */
export function __makeSharedUsage<T>(deps: SharedUsageDeps<T>) {
    const { ops } = deps;
    const cacheKey = `snapshots:${deps.provider}`;

    return async function getShared(opts: SharedUsageOpts): Promise<T[]> {
        const staleMs = opts.maxStaleMs ?? API_MIN_INTERVAL_MS;
        const cached = await deps.getCache(cacheKey);

        if (!opts.force && cached && Date.now() - cached.fetchedAt < staleMs) {
            return filterAccounts(ops, cached.accounts, opts.accountFilter);
        }

        try {
            return await deps.withLock(cacheKey, async () => {
                const c2 = await deps.getCache(cacheKey);

                if (!opts.force && c2 && Date.now() - c2.fetchedAt < staleMs) {
                    return filterAccounts(ops, c2.accounts, opts.accountFilter);
                }

                const previous = c2 ?? cached;
                const fresh = backfillFromLastGood(
                    ops,
                    await deps.fetchAll({ orgBlocked: ops.orgBlocked(previous?.accounts) }),
                    previous
                );
                const fetchedAt = Date.now();
                await deps.putCache(cacheKey, { fetchedAt, accounts: fresh });

                if (deps.recordHistory) {
                    try {
                        // recordHistory skips stale-backfilled accounts itself.
                        await deps.recordHistory(fresh);
                    } catch (err) {
                        logger.warn({ err }, "history write-through failed; returning fetched usage anyway");
                    }
                }

                if (deps.notifyExtraUsage) {
                    try {
                        // Stale entries replay old spend values — notifying on
                        // them would re-fire thresholds already handled.
                        await deps.notifyExtraUsage(fresh.filter((a) => !ops.isStale(a)));
                    } catch (err) {
                        logger.warn({ err }, "extra usage notification pass failed; returning fetched usage anyway");
                    }
                }

                if (deps.onFresh) {
                    try {
                        await deps.onFresh(fresh, fetchedAt);
                    } catch (err) {
                        logger.warn({ err }, "usage cache projection failed; returning fetched usage anyway");
                    }
                }

                return filterAccounts(ops, fresh, opts.accountFilter);
            });
        } catch (err) {
            // Lock contention (e.g. the daemon holds the lock through a slow
            // multi-account fetch) or a whole-fetch failure must not blank out
            // consumers — degrade to the last cached payload, marked stale so
            // callers know exactly how old it is and why.
            const fallback = await deps.getCache(cacheKey);

            if (!fallback) {
                throw err;
            }

            const reason = err instanceof Error ? err.message : String(err);
            logger.warn({ err }, "usage fetch unavailable; serving stale cache");
            return filterAccounts(ops, markAllStale(ops, fallback, reason), opts.accountFilter);
        }
    };
}

/** `UsageEntryOps` for the provider-neutral snapshot, used by `pollAccounts`. */
export const SNAPSHOT_OPS: UsageEntryOps<AccountUsageSnapshot> = {
    nameOf: (entry) => entry.accountName,
    hasData: (entry) => entry.limits.length > 0,
    errorOf: (entry) => entry.error,
    isStale: (entry) => entry.stale !== undefined,
    backfill: (entry, previous, previousFetchedAt) => ({
        ...entry,
        limits: previous.limits,
        plan: entry.plan ?? previous.plan,
        stale: {
            lastSuccessAt: previous.stale?.lastSuccessAt ?? new Date(previousFetchedAt).toISOString(),
            reason: entry.error ?? "fetch failed",
        },
        auth: {
            ...previous.auth,
            ...entry.auth,
            orgBlocked: entry.auth?.orgBlocked || previous.auth?.orgBlocked,
        },
    }),
    markStale: (entry, reason, fetchedAt) => ({
        ...entry,
        stale: {
            lastSuccessAt: entry.stale?.lastSuccessAt ?? new Date(fetchedAt).toISOString(),
            reason,
        },
    }),
    orgBlocked: (entries) => {
        const blocked = new Set<string>();

        for (const entry of entries ?? []) {
            if (entry.auth?.orgBlocked) {
                blocked.add(entry.accountName);
            }
        }

        return blocked;
    },
};
