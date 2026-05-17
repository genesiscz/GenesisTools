import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { UsageSnapshot } from "@app/claude/lib/usage/history-db";

export interface UsageHistoryResult {
    snapshots: UsageSnapshot[];
    hint?: string;
}

export interface BucketSeries {
    bucket: string;
    snapshots: UsageSnapshot[];
}

export interface MultiBucketHistoryResult {
    series: BucketSeries[];
    hint?: string;
}

export type { AccountUsage, UsageSnapshot };
