import type { AccountUsage } from "@app/claude/lib/usage/api";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
import type { MultiBucketHistoryResult, UsageHistoryResult } from "./types";

export function getCurrentUsage(): Promise<AccountUsage[]> {
    return getSharedAccountsUsage();
}

export function getUsageHistory(
    opts: { account: string; bucket: string; minutes: number },
    db?: UsageHistoryDb
): UsageHistoryResult {
    // When no db is injected we use the process-wide ClaudeDatabase singleton
    // (UsageHistoryDb's default ctor). It must NOT be closed here — closing it
    // breaks every later request that reuses the cached singleton handle.
    const historyDb = db ?? new UsageHistoryDb();
    const snapshots = historyDb.getSnapshots(opts.account, opts.bucket, opts.minutes);

    if (snapshots.length === 0) {
        return { snapshots: [], hint: "Run 'tools claude daemon install' to start polling." };
    }

    return { snapshots };
}

/**
 * History for several buckets of one account in a single DB pass — drives the
 * multi-line per-account usage chart (5h / 7-day / Sonnet) so the client makes
 * one request per account instead of one per bucket.
 */
export function getUsageHistoryMulti(
    opts: { account: string; buckets: string[]; minutes: number },
    db?: UsageHistoryDb
): MultiBucketHistoryResult {
    const historyDb = db ?? new UsageHistoryDb();
    const series = opts.buckets.map((bucket) => ({
        bucket,
        snapshots: historyDb.getSnapshots(opts.account, bucket, opts.minutes),
    }));

    if (series.every((s) => s.snapshots.length === 0)) {
        return { series, hint: "Run 'tools claude daemon install' to start polling." };
    }

    return { series };
}
