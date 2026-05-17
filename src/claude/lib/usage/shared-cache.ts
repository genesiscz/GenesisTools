import { join } from "node:path";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getClaudeUsageStorage } from "@app/claude/lib/usage/storage";
import type { AccountUsage } from "./api";
import { fetchAllAccountsUsage } from "./api";

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
    record: (accounts: AccountUsage[]) => void;
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

function recordAll(accounts: AccountUsage[]): void {
    const db = new UsageHistoryDb();

    for (const account of accounts) {
        if (!account.usage) {
            continue;
        }

        for (const [bucket, data] of Object.entries(account.usage)) {
            if (data && typeof data.utilization === "number") {
                db.recordIfChanged(account.accountName, bucket, data.utilization, data.resets_at ?? null);
            }
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
            deps.record(fresh);
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
    record: recordAll,
});

export function getSharedAccountsUsage(opts: SharedUsageOpts = {}): Promise<AccountUsage[]> {
    return realGetShared(opts);
}
