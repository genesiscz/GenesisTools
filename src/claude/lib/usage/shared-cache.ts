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

interface Cached {
    fetchedAt: number;
    accounts: AccountUsage[];
}

interface Deps {
    fetchAll: (filter?: string | string[]) => Promise<AccountUsage[]>;
    getCache: (key: string) => (Cached | null) | Promise<Cached | null>;
    putCache: (key: string, value: Cached) => void | Promise<void>;
    withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
    notifyExtraUsage?: (accounts: AccountUsage[]) => void | Promise<void>;
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
 * Write fetched usage to the history DB. Owned by the daemon — see poll-daemon.ts.
 * Other consumers (TUI dashboard, dev-dashboard) read from this DB but do not
 * write to it; the daemon is the single source of truth for history rows.
 * Prior to 2026-06-30, this ran on every fresh fetch from any consumer, which
 * combined with the TUI's legacy V1 writer to insert twin rows per poll.
 */
export function recordAll(accounts: AccountUsage[]): void {
    // No dbPath -> UsageHistoryDb resolves the process-wide ClaudeDatabase
    // singleton (see ClaudeDatabase.getInstance), the same connection
    // poll-daemon.ts already holds open in its own `db` and closes once in
    // its top-level `finally` after recordAll() and pruneOlderThan() both
    // run. Closing it here would sever that shared connection mid-flight.
    const db = new UsageHistoryDb();

    for (const account of accounts) {
        if (!account.usage) {
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

// Exported for tests: build the accessor with injected dependencies.
export function __makeSharedUsage(deps: Deps) {
    return async function getShared(opts: SharedUsageOpts): Promise<AccountUsage[]> {
        const staleMs = opts.maxStaleMs ?? API_MIN_INTERVAL_MS;
        const cached = await deps.getCache(CACHE_KEY);

        if (!opts.force && cached && Date.now() - cached.fetchedAt < staleMs) {
            return filterAccounts(cached.accounts, opts.accountFilter);
        }

        return deps.withLock(CACHE_KEY, async () => {
            const c2 = await deps.getCache(CACHE_KEY);

            if (!opts.force && c2 && Date.now() - c2.fetchedAt < staleMs) {
                return filterAccounts(c2.accounts, opts.accountFilter);
            }

            const fresh = await deps.fetchAll();
            await deps.putCache(CACHE_KEY, { fetchedAt: Date.now(), accounts: fresh });

            if (deps.notifyExtraUsage) {
                try {
                    await deps.notifyExtraUsage(fresh);
                } catch (err) {
                    logger.warn({ err }, "extra usage notification pass failed; returning fetched usage anyway");
                }
            }

            return filterAccounts(fresh, opts.accountFilter);
        });
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
});

export function getSharedAccountsUsage(opts: SharedUsageOpts = {}): Promise<AccountUsage[]> {
    return realGetShared(opts);
}
