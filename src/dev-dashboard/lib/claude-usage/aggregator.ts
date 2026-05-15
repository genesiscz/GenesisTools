import { fetchAllAccountsUsage } from "@app/claude/lib/usage/api";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { UsageHistoryResult } from "./types";

export function getCurrentUsage(): Promise<AccountUsage[]> {
    return fetchAllAccountsUsage();
}

export function getUsageHistory(
    opts: { account: string; bucket: string; minutes: number },
    db?: UsageHistoryDb
): UsageHistoryResult {
    const ownsDb = !db;
    const historyDb = db ?? new UsageHistoryDb();

    try {
        const snapshots = historyDb.getSnapshots(opts.account, opts.bucket, opts.minutes);

        if (snapshots.length === 0) {
            return { snapshots: [], hint: "Run 'tools claude daemon install' to start polling." };
        }

        return { snapshots };
    } finally {
        if (ownsDb) {
            historyDb.close();
        }
    }
}
