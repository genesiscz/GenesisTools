import type { AccountUsage } from "@app/claude/lib/usage/api";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
import type { UsageHistoryResult } from "./types";

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
