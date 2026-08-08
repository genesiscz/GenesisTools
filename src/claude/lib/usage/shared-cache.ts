import { join } from "node:path";
import { processExtraUsageNotifications } from "@app/claude/lib/usage/extra-usage-notify";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getClaudeUsageStorage } from "@app/claude/lib/usage/storage";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { recordUsage } from "@genesiscz/utils/ai/usage";
import { logger } from "@genesiscz/utils/logger";
import type { AccountUsage } from "./api";
import { fetchAllAccountsUsage, isSubscriptionExpiredError, orgBlockedAccounts } from "./api";
import { normalizeLimits, normalizeSpend } from "./limits";

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

const CACHE_KEY = "usage-shared";
const storage = getClaudeUsageStorage();

export interface Cached {
    fetchedAt: number;
    accounts: AccountUsage[];
}

interface Deps {
    fetchAll: (opts: { accountFilter?: string | string[]; orgBlocked: ReadonlySet<string> }) => Promise<AccountUsage[]>;
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
 *
 * It ALSO mirrors each newly-changed bucket into the shared usage layer
 * (`src/utils/ai/usage`) as a `bucket-snapshot` event, so a cross-surface query
 * can see Claude subscription pressure next to per-token spend. The DB remains
 * the source of truth for buckets; the events are additive and carry no tokens.
 */
export async function recordAll(accounts: AccountUsage[]): Promise<void> {
    // No dbPath -> UsageHistoryDb resolves the process-wide ClaudeDatabase
    // singleton (see ClaudeDatabase.getInstance) — in the daemon that is the
    // same connection poll-daemon.ts holds open in its own `db` and closes
    // once in its top-level `finally`. Closing it here would sever that
    // shared connection mid-flight.
    const db = new UsageHistoryDb();
    const accountIds = await accountIdsByName();

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

            const changed = db.recordIfChangedV2(account.accountName, limit.bucket, limit.percent, {
                resetsAt: limit.resets_at,
                severity: limit.severity,
                scopeModel: limit.scope_model,
            });

            // Only on a real change. The poller runs every ~30s against five
            // buckets per account; mirroring unchanged values would append tens
            // of thousands of identical rows a day to an append-only log.
            if (changed) {
                void recordUsage({
                    app: "claude",
                    accountId: accountIds.get(account.accountName) ?? account.accountName,
                    provider: "anthropic-sub",
                    modelId: limit.scope_model ?? limit.bucket,
                    // A limit bucket is a percentage, not a token count. Zeroes
                    // here are honest: these events say "pressure changed", and
                    // per-token spend is what the call-site emitters record.
                    inputTokens: 0,
                    outputTokens: 0,
                    meta: {
                        kind: "bucket-snapshot",
                        bucket: limit.bucket,
                        utilization: limit.percent,
                        resetsAt: limit.resets_at,
                        severity: limit.severity,
                    },
                });
            }
        }

        const spend = normalizeSpend(account.usage);

        if (spend) {
            db.recordSpendIfChanged(account.accountName, spend);
        }
    }
}

/**
 * Account NAME → `acc_…` id, so the mirrored events group with the ones the core
 * call path emits (which knows ids). A name that resolves to nothing keeps the
 * name as its key rather than dropping the row.
 */
async function accountIdsByName(): Promise<Map<string, string>> {
    try {
        const store = await AiConfigStore.load();
        return new Map(store.accounts().map((entry) => [entry.name, entry.id]));
    } catch (err) {
        logger.debug({ err }, "usage mirror: could not read account ids; falling back to account names");
        return new Map();
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
            // The flag must survive the backfill: without it a poll that 403s
            // once and then 429s forever would look unblocked again and re-arm
            // the force-refresh retry.
            orgBlocked: account.orgBlocked || isSubscriptionExpiredError(account.error) || prevAccount.orgBlocked,
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

                const previous = c2 ?? cached;
                const fresh = backfillFromLastGood(
                    await deps.fetchAll({ orgBlocked: orgBlockedAccounts(previous?.accounts) }),
                    previous
                );
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
    fetchAll: (opts) => fetchAllAccountsUsage(opts),
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

/**
 * Drop the shared cache so the next read rebuilds it. Needed after anything
 * that changes what an account is CALLED, since every entry is name-keyed and
 * a stale entry would render as a ghost row under the old name.
 */
export async function invalidateSharedUsage(): Promise<void> {
    await storage.putCacheFile(CACHE_KEY, { fetchedAt: 0, accounts: [] }, CACHE_TTL);
    logger.debug("[usage] shared cache invalidated");
}

/** Read the last cached usage payload WITHOUT ever triggering a fetch. */
export async function peekSharedUsage(): Promise<Cached | null> {
    return (await storage.getCacheFile<Cached>(CACHE_KEY, CACHE_TTL)) ?? null;
}
