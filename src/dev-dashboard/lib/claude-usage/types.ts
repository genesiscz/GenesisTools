import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { UsageSnapshot } from "@app/claude/lib/usage/history-db";
import type { UsageAggregate } from "@genesiscz/utils/ai/usage";

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

export interface AccountTotals {
    /** The key rows are grouped by — an `acc_…` id, or an account name for rows emitted before ids existed. */
    key: string;
    /** Display handle. Falls back to `key` for a group no configured account claims. */
    name: string;
    label?: string;
    /** False for a group that matches no account the dashboard shows (a stale id, another machine's rows). */
    known: boolean;
    totals: UsageAggregate;
}

/** Cross-surface token/cost totals over a window, from the shared usage layer. */
export interface UsageTotalsResult {
    from: string;
    to: string;
    total: UsageAggregate;
    accounts: AccountTotals[];
    byApp: Record<string, UsageAggregate>;
}

export type { AccountUsage, UsageAggregate, UsageSnapshot };
