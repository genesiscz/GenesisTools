import { join } from "node:path";
import { processExtraUsageNotifications } from "@app/claude/lib/usage/extra-usage-notify";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getClaudeUsageStorage } from "@app/claude/lib/usage/storage";
import { logger } from "@app/logger";
import type { AccountUsage } from "./api";
import { fetchAllAccountsUsage } from "./api";
import { normalizeLimits, normalizeSpend } from "./limits";

export const DB_FRESH_MS = 10_000;
export const API_MIN_INTERVAL_MS = 30_000;

const CACHE_KEY = "usage-shared";
const storage = getClaudeUsageStorage();

export interface Cached {
    fetchedAt: number;
    accounts: AccountUsage[];
}

interface Deps {
    fetchAll: (filter?: string | string[]) => Promise<AccountUsage[]>;
    getCache: (key: string) => (Cached | null) | Promise<Cached | null>;
    putCache: (key: string, value: Cached) => void | Promise<void>;
    withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
    notifyExtraUsage?: (accounts: AccountUsage[]) => void | Promise<void>;
    recordHistory?: (accounts: AccountUsage[]) => void | Promise<void>;
}

export interface SharedUsageOpts {
    accountFilter?: string | string[];
    force?: boolean;
    /** Serve cache if a successful fetch happened within this many ms. Default API_MIN_INTERVAL_MS. */
    maxStaleMs?: number;
}

function filterAccounts(accounts: AccountUsage[], filter?: string | string[]): AccountUsage[] {
    if (filter === undefined) {
        return accounts;
    }

    const set = new Set(Array.isArray(filter) ? filter : [filter]);
    return accounts.filter((a) => set.has(a.accountName));
}

/**
 * Write fetched usage to the history DB. Runs as a write-through inside the
 * shared accessor on every live fetch — whichever consumer (daemon, TUI,
 * dev-dashboard, watch) wins the fetch, the rows land. Serialized by the
 * accessor's file lock; recordIfChangedV2 dedups unchanged values, and the
 * TUI's legacy V1 writer (the old twin-row source) is gone. Prior to
 * 2026-07-12 only the daemon recorded, so successes fetched by other
 * consumers refreshed the Overview but left multi-minute holes in History
 * whenever the daemon's own polls were failing (e.g. 429/invalid_grant).
 */
export function recordAll(accounts: AccountUsage[]): void {
    // No dbPath -> UsageHistoryDb resolves the process-wide ClaudeDatabase
    // singleton (see ClaudeDatabase.getInstance) — in the daemon that is the
    // same connection poll-daemon.ts holds open in its own `db` and closes
    // once in its top-level `finally`. Closing it here would sever that
    // shared connection mid-flight.
    const db = new UsageHistoryDb();

    for (const account of accounts) {
        // Stale entries are replays of an older successful fetch — recording
        // them would re-timestamp old utilization as if it were current.
        if (!account.usage || account.stale) {
            continue;
        }

        const limits = normalizeLimits(account.usage);

        for (const limit of limits) {
            if (typeof limit.percent !== "number") {
                continue;
            }

            db.recordIfChangedV2(account.accountName, limit.bucket, limit.percent, {
                resetsAt: limit.resets_at,
                severity: limit.severity,
                scopeModel: limit.scope_model,
            });
        }

        const spend = normalizeSpend(account.usage);

        if (spend) {
            db.recordSpendIfChanged(account.accountName, spend);
        }
    }
}

/**
 * Backfill accounts whose live fetch failed with the last-good usage payload
 * from the previous cache entry, marked `stale` so consumers can render the
 * data with an age indicator and writers can skip it. Chained failures keep
 * the ORIGINAL success timestamp (prev entry's own stale.lastSuccessAt wins
 * over the cache write time).
 */
function backfillFromLastGood(fresh: AccountUsage[], prev: Cached | null): AccountUsage[] {
    if (!prev) {
        return fresh;
    }

    return fresh.map((account) => {
        if (account.usage || !account.error) {
            return account;
        }

        const prevAccount = prev.accounts.find((p) => p.accountName === account.accountName);

        if (!prevAccount?.usage) {
            return account;
        }

        return {
            ...account,
            usage: prevAccount.usage,
            stale: {
                lastSuccessAt: prevAccount.stale?.lastSuccessAt ?? prev.fetchedAt,
                reason: account.error,
            },
        };
    });
}

/** Mark every usage-bearing account in a cache entry stale with the given reason. */
function markAllStale(entry: Cached, reason: string): AccountUsage[] {
    return entry.accounts.map((account) => {
        if (!account.usage) {
            return account;
        }

        return {
            ...account,
            stale: {
                lastSuccessAt: account.stale?.lastSuccessAt ?? entry.fetchedAt,
                reason,
            },
        };
    });
}

// Exported for tests: build the accessor with injected dependencies.
export function __makeSharedUsage(deps: Deps) {
    return async function getShared(opts: SharedUsageOpts): Promise<AccountUsage[]> {
        const staleMs = opts.maxStaleMs ?? API_MIN_INTERVAL_MS;
        const cached = await deps.getCache(CACHE_KEY);

        if (!opts.force && cached && Date.now() - cached.fetchedAt < staleMs) {
            return filterAccounts(cached.accounts, opts.accountFilter);
        }

        try {
            return await deps.withLock(CACHE_KEY, async () => {
                const c2 = await deps.getCache(CACHE_KEY);

                if (!opts.force && c2 && Date.now() - c2.fetchedAt < staleMs) {
                    return filterAccounts(c2.accounts, opts.accountFilter);
                }

                const fresh = backfillFromLastGood(await deps.fetchAll(), c2 ?? cached);
                await deps.putCache(CACHE_KEY, { fetchedAt: Date.now(), accounts: fresh });

                if (deps.recordHistory) {
                    try {
                        // recordAll skips stale-backfilled accounts itself.
                        await deps.recordHistory(fresh);
                    } catch (err) {
                        logger.warn({ err }, "history write-through failed; returning fetched usage anyway");
                    }
                }

                if (deps.notifyExtraUsage) {
                    try {
                        // Stale entries replay old spend values — notifying on
                        // them would re-fire thresholds already handled.
                        await deps.notifyExtraUsage(fresh.filter((a) => !a.stale));
                    } catch (err) {
                        logger.warn({ err }, "extra usage notification pass failed; returning fetched usage anyway");
                    }
                }

                return filterAccounts(fresh, opts.accountFilter);
            });
        } catch (err) {
            // Lock contention (e.g. the daemon holds the lock through a slow
            // multi-account fetch) or a whole-fetch failure must not blank out
            // consumers — degrade to the last cached payload, marked stale so
            // callers know exactly how old it is and why.
            const fallback = await deps.getCache(CACHE_KEY);

            if (!fallback) {
                throw err;
            }

            const reason = err instanceof Error ? err.message : String(err);
            logger.warn({ err }, "usage fetch unavailable; serving stale cache");
            return filterAccounts(markAllStale(fallback, reason), opts.accountFilter);
        }
    };
}

// Long TTL so the cache file's mtime never evicts the payload before our own
// `fetchedAt` staleness check runs; freshness is gated in our code, not by mtime.
const CACHE_TTL = "365 days" as const;

const realGetShared = __makeSharedUsage({
    fetchAll: (filter) => fetchAllAccountsUsage(filter),
    getCache: async (key) => (await storage.getCacheFile<Cached>(key, CACHE_TTL)) ?? null,
    putCache: (key, value) => storage.putCacheFile(key, value, CACHE_TTL),
    withLock: (key, fn) =>
        storage.withFileLock({
            file: join(storage.getCacheDir(), key),
            fn,
            timeout: 10_000,
        }),
    notifyExtraUsage: processExtraUsageNotifications,
    recordHistory: recordAll,
});

export function getSharedAccountsUsage(opts: SharedUsageOpts = {}): Promise<AccountUsage[]> {
    return realGetShared(opts);
}

/** Read the last cached usage payload WITHOUT ever triggering a fetch. */
export async function peekSharedUsage(): Promise<Cached | null> {
    return (await storage.getCacheFile<Cached>(CACHE_KEY, CACHE_TTL)) ?? null;
}
