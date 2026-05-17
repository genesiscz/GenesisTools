import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { UsageSnapshot } from "@app/claude/lib/usage/history-db";

export interface UsageHistoryResult {
    snapshots: UsageSnapshot[];
    hint?: string;
}

export type { AccountUsage, UsageSnapshot };
