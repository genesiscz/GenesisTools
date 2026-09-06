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
    /**
     * Epoch ms of the fetch each account's row came from, by account name.
     *
     * The file-level `fetchedAt` belongs to the round that WROTE it, and a filtered round
     * only fetched the accounts it was asked about while carrying the rest over unchanged.
     * Trusting one stamp for the whole provider made a filtered poll declare every other
     * account fresh: on a cold cache, polling `work` and then `personal` inside the window
     * returned nothing at all for `personal` (PR #361 review t6). Absent for an entry
     * written before this field existed, which falls back to `fetchedAt`.
     */
    accountFetchedAt?: Record<string, number>;
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
    /**
     * Ran after every LIVE fetch, with the whole payload that was cached — this round's rows
     * plus the accounts a FILTERED round never asked about. Used for the legacy projection,
     * which must not shrink the Genesis app's file to whatever one filtered poll fetched.
     */
    onFresh?: (accounts: T[], fetchedAt: number) => void | Promise<void>;
}

export interface SharedUsageOpts {
    accountFilter?: string | string[];
    force?: boolean;
    /** Serve cache if a successful fetch happened within this many ms. Default API_MIN_INTERVAL_MS. */
    maxStaleMs?: number;
    /**
     * Hard floor between two LIVE fetches of this provider, which `force` does not bypass.
     *
     * `force` means "do not serve me the shared 45s cache", which is what the every-30s
     * daemon needs from anthropic. It used to mean "fetch unconditionally", so the daemon
     * spawned a `codex app-server` and hit grok on every tick despite their 120s/300s
     * floors. The floor protects the provider, so only it is exempt from `force`.
     */
    floorMs?: number;
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

/**
 * What one poll should WRITE to a cache file that holds the whole provider.
 *
 * An unfiltered round is authoritative and replaces the set, so an account dropped from
 * the config stops being served. A FILTERED round fetched only the accounts it was asked
 * about, so writing its list alone made every other account vanish until the next full
 * round; those are carried over from the previous entry with whatever staleness they had.
 */
function cacheableSet<T>(
    ops: UsageEntryOps<T>,
    fresh: T[],
    prev: Cached<T> | null,
    filter: string | string[] | undefined
): T[] {
    if (filter === undefined || !prev) {
        return fresh;
    }

    const fetched = new Set(fresh.map((account) => ops.nameOf(account)));
    const carried = prev.accounts.filter((account) => !fetched.has(ops.nameOf(account)));

    if (carried.length === 0) {
        return fresh;
    }

    return [...fresh, ...carried];
}

/** When each row in `cacheable` was actually fetched: now for this round's, else its old stamp. */
function stampAccounts<T>(
    ops: UsageEntryOps<T>,
    fresh: T[],
    cacheable: T[],
    prev: Cached<T> | null,
    fetchedAt: number
): Record<string, number> {
    const fetchedNames = new Set(fresh.map((account) => ops.nameOf(account)));
    const stamps: Record<string, number> = {};

    for (const account of cacheable) {
        const name = ops.nameOf(account);
        stamps[name] = fetchedNames.has(name) ? fetchedAt : (prev?.accountFetchedAt?.[name] ?? prev?.fetchedAt ?? 0);
    }

    return stamps;
}

/**
 * The rows a cached entry may answer this request with, or null when it must fetch.
 *
 * A hit needs BOTH coverage and freshness: every account the caller named has to be in the
 * entry, and no row it will return may be older than `staleMs`. The old check compared one
 * provider-wide stamp, so a filtered round that touched one account marked the whole
 * provider fresh (PR #361 review t6).
 */
function servableFrom<T>(
    ops: UsageEntryOps<T>,
    cached: Cached<T> | null,
    filter: string | string[] | undefined,
    staleMs: number,
    now: number
): T[] | null {
    if (!cached) {
        return null;
    }

    const rows = filterAccounts(ops, cached.accounts, filter);

    if (filter !== undefined) {
        const wanted = new Set(Array.isArray(filter) ? filter : [filter]);

        if (rows.length < wanted.size) {
            return null;
        }
    }

    for (const row of rows) {
        const stamp = cached.accountFetchedAt?.[ops.nameOf(row)] ?? cached.fetchedAt;

        if (now - stamp >= staleMs) {
            return null;
        }
    }

    // An empty entry has nothing to go stale, so the file stamp is all there is to judge.
    if (rows.length === 0 && now - cached.fetchedAt >= staleMs) {
        return null;
    }

    return rows;
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
        // Under `force` the shared window collapses to the provider's own floor, which is
        // 0 for a provider that declares none — the old unconditional-fetch behaviour.
        const staleMs = opts.force ? (opts.floorMs ?? 0) : (opts.maxStaleMs ?? API_MIN_INTERVAL_MS);
        const cached = await deps.getCache(cacheKey);
        const servable = staleMs > 0 ? servableFrom(ops, cached, opts.accountFilter, staleMs, Date.now()) : null;

        if (servable) {
            return servable;
        }

        try {
            return await deps.withLock(cacheKey, async () => {
                const c2 = await deps.getCache(cacheKey);
                const servable2 = staleMs > 0 ? servableFrom(ops, c2, opts.accountFilter, staleMs, Date.now()) : null;

                if (servable2) {
                    return servable2;
                }

                const previous = c2 ?? cached;
                const fresh = backfillFromLastGood(
                    ops,
                    await deps.fetchAll({ orgBlocked: ops.orgBlocked(previous?.accounts) }),
                    previous
                );
                const fetchedAt = Date.now();
                const cacheable = cacheableSet(ops, fresh, previous, opts.accountFilter);
                await deps.putCache(cacheKey, {
                    fetchedAt,
                    accounts: cacheable,
                    accountFetchedAt: stampAccounts(ops, fresh, cacheable, previous, fetchedAt),
                });

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
                        await deps.onFresh(cacheable, fetchedAt);
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
        // The provider-native payload rides along with the limits it was derived from.
        // `snapshotToAccountUsage` reads `native` and nothing else, so a backfilled row
        // without it left the claude presenter, `tools claude start` and the Genesis
        // projection with no usage bars at all after one transient failure.
        ...(entry.native === undefined && previous.native !== undefined ? { native: previous.native } : {}),
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
