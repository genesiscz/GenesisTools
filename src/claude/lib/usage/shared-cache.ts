import { processExtraUsageNotifications } from "@app/claude/lib/usage/extra-usage-notify";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { recordUsage } from "@genesiscz/utils/ai/usage";
import { writeLegacyUsageShared } from "@genesiscz/utils/ai/usage-poll/legacy-cache";
import type { Cached, SharedUsageOpts, UsageEntryOps } from "@genesiscz/utils/ai/usage-poll/shared-cache";
import { __makeSharedUsage } from "@genesiscz/utils/ai/usage-poll/shared-cache";
import {
    snapshotsCacheKey,
    USAGE_CACHE_TTL,
    usageCacheFilePath,
    usagePollStorage,
} from "@genesiscz/utils/ai/usage-poll/storage";
import { logger } from "@genesiscz/utils/logger";
import type { AccountUsage } from "./api";
import { fetchAllAccountsUsage, isSubscriptionExpiredError } from "./api";
import { normalizeLimits, normalizeSpend } from "./limits";

export {
    __makeSharedUsage,
    API_MIN_INTERVAL_MS,
    type Cached,
    DB_FRESH_MS,
    type SharedUsageOpts,
} from "@genesiscz/utils/ai/usage-poll/shared-cache";

const PROVIDER = "anthropic-sub";
const CACHE_KEY = snapshotsCacheKey(PROVIDER);
const storage = usagePollStorage();

/**
 * Write fetched usage to the limits store. Runs as a write-through inside the
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
        const accountId = accountIds.get(account.accountName);

        for (const limit of limits) {
            if (typeof limit.percent !== "number") {
                continue;
            }

            const changed = db.recordIfChangedV2(account.accountName, limit.bucket, limit.percent, {
                resetsAt: limit.resets_at,
                severity: limit.severity,
                scopeModel: limit.scope_model,
                provider: PROVIDER,
                accountId: accountId ?? null,
                kind: limitKind(limit.bucket, limit.scope_model),
            });

            // Only on a real change. The poller runs every ~30s against five
            // buckets per account; mirroring unchanged values would append tens
            // of thousands of identical rows a day to an append-only log.
            if (changed) {
                void recordUsage({
                    app: "claude",
                    accountId: accountId ?? account.accountName,
                    provider: PROVIDER,
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
            db.recordSpendIfChanged(account.accountName, spend, PROVIDER);
        }
    }
}

/**
 * `LimitWindow.kind` for an anthropic bucket (orchestrator amendment 3): `five_hour` is a
 * session window, a scoped weekly window keeps its model, everything else is a plain weekly.
 * The legacy `weekly_all` / `five_hour` names live only in the legacy projection.
 */
function limitKind(bucket: string, scopeModel: string | null): string {
    if (scopeModel) {
        return "scoped";
    }

    return bucket === "five_hour" ? "session" : "weekly";
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
 * How the generic accessor reads an anthropic `AccountUsage` row. The `orgBlocked` rule is
 * sticky on purpose: a dead org answers inconsistently, so inferring the block from the
 * latest error alone would let a single 429 erase it and re-arm the force-refresh.
 */
export const ACCOUNT_USAGE_OPS: UsageEntryOps<AccountUsage> = {
    nameOf: (entry) => entry.accountName,
    hasData: (entry) => entry.usage !== undefined,
    errorOf: (entry) => entry.error,
    isStale: (entry) => entry.stale !== undefined,
    backfill: (entry, previous, previousFetchedAt) => ({
        ...entry,
        usage: previous.usage,
        stale: {
            lastSuccessAt: previous.stale?.lastSuccessAt ?? previousFetchedAt,
            // Only reached for entries that carry an error (see backfillFromLastGood).
            reason: entry.error ?? "fetch failed",
        },
        // The flag must survive the backfill: without it a poll that 403s
        // once and then 429s forever would look unblocked again and re-arm
        // the force-refresh retry.
        orgBlocked: entry.orgBlocked || isSubscriptionExpiredError(entry.error) || previous.orgBlocked,
    }),
    markStale: (entry, reason, fetchedAt) => ({
        ...entry,
        stale: {
            lastSuccessAt: entry.stale?.lastSuccessAt ?? fetchedAt,
            reason,
        },
    }),
    orgBlocked: (entries) => {
        const blocked = new Set<string>();

        for (const entry of entries ?? []) {
            if (
                entry.orgBlocked ||
                isSubscriptionExpiredError(entry.error) ||
                isSubscriptionExpiredError(entry.stale?.reason)
            ) {
                blocked.add(entry.accountName);
            }
        }

        return blocked;
    },
};

const realGetShared = __makeSharedUsage<AccountUsage>({
    provider: PROVIDER,
    ops: ACCOUNT_USAGE_OPS,
    fetchAll: (opts) => fetchAllAccountsUsage(opts),
    getCache: async (key) => (await storage.getCacheFile<Cached<AccountUsage>>(key, USAGE_CACHE_TTL)) ?? null,
    putCache: (key, value) => storage.putCacheFile(key, value, USAGE_CACHE_TTL),
    withLock: (key, fn) =>
        storage.withFileLock({
            file: usageCacheFilePath(key),
            fn,
            timeout: 10_000,
        }),
    notifyExtraUsage: processExtraUsageNotifications,
    recordHistory: recordAll,
    // The Genesis app still reads `~/.genesis-tools/claude-usage/cache/usage-shared`
    // directly, so every live anthropic fetch keeps that file current (spec 6.4).
    onFresh: (accounts, fetchedAt) => writeLegacyUsageShared(accounts, fetchedAt),
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
    await storage.putCacheFile(CACHE_KEY, { fetchedAt: 0, accounts: [] }, USAGE_CACHE_TTL);
    logger.debug("[usage] shared cache invalidated");
}

/** Read the last cached usage payload WITHOUT ever triggering a fetch. */
export async function peekSharedUsage(): Promise<Cached<AccountUsage> | null> {
    return (await storage.getCacheFile<Cached<AccountUsage>>(CACHE_KEY, USAGE_CACHE_TTL)) ?? null;
}
