import type { AccountUsage, DashboardClient, MultiBucketHistoryResult, UsageTotalsResult } from "@dd/contract";
import { paths } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Claude-usage feature data layer (D32 + per-feature layout). Co-locates `claudeUsageKeys` and the
 * `queryOptions` factories over the injected `DashboardClient`. Mirrors src/features/pulse/queries.ts.
 *
 * ESCAPE-HATCH NOTE: the contract has no precisely-typed `client.claude.*` namespace yet — the
 * deferred features go through the generic `client.get<T>(path)` until they're typed (the contract's
 * own comment says so). We supply `T` explicitly here (`AccountUsage[]`, `MultiBucketHistoryResult`)
 * and build paths via the contract's `paths.*` builders — the single source of truth for routes.
 *
 * MOCK GAP (flagged, NOT fixed — mock-client.ts is shared/read-only): the mock's escape hatch
 * returns `[MOCK_USAGE]` (an AccountUsage[]) for BOTH `/api/claude/usage` AND its prefix
 * `/api/claude/usage/history` — so the history query gets the wrong shape under the mock. The
 * `usageHistoryQuery` queryFn here coerces a non-`series` payload to an empty `{ series: [] }` so
 * parallel-dev under the mock renders an empty chart instead of crashing. On a REAL device the
 * agent returns a true MultiBucketHistoryResult. See 20-impl-09-rest-notes.md.
 *
 * Polling: 30 s for both the live usage snapshot and the history (utilization moves slowly).
 */

export const claudeUsageKeys = {
    usage: ["claude-usage", "accounts"] as const,
    history: (account: string, minutes: number) => ["claude-usage", "history", account, minutes] as const,
    totals: (minutes: number) => ["claude-usage", "totals", minutes] as const,
} as const;

export const USAGE_INTERVAL_MS = 30_000;
export const HISTORY_INTERVAL_MS = 30_000;

/** Buckets requested for the history charts (5h burn-down + the 7d totals/models). */
export const HISTORY_BUCKETS = ["five_hour", "seven_day", "seven_day_sonnet"] as const;

/** Coerce any escape-hatch payload to a well-formed MultiBucketHistoryResult (mock-gap guard). */
function asHistory(value: unknown): MultiBucketHistoryResult {
    if (value && typeof value === "object" && Array.isArray((value as { series?: unknown }).series)) {
        return value as MultiBucketHistoryResult;
    }

    return { series: [] };
}

export function usageAccountsQuery(client: DashboardClient) {
    return queryOptions<AccountUsage[]>({
        queryKey: claudeUsageKeys.usage,
        queryFn: async () => {
            const accounts = await client.get<AccountUsage[]>(paths.claudeUsage());
            return Array.isArray(accounts) ? accounts : [];
        },
        refetchInterval: USAGE_INTERVAL_MS,
    });
}

export function usageHistoryQuery(client: DashboardClient, account: string, minutes: number) {
    return queryOptions<MultiBucketHistoryResult>({
        queryKey: claudeUsageKeys.history(account, minutes),
        queryFn: async () => {
            const result = await client.get<MultiBucketHistoryResult>(
                paths.claudeUsageHistory({ account, buckets: [...HISTORY_BUCKETS], minutes }),
            );
            return asHistory(result);
        },
        refetchInterval: HISTORY_INTERVAL_MS,
    });
}

/** Empty totals for a window the agent could not summarise — renders the "no events yet" state. */
function emptyTotals(): UsageTotalsResult {
    const zero = { events: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedEvents: 0 };

    return { from: "", to: "", total: zero, accounts: [], byApp: {} };
}

/**
 * Same escape-hatch caveat as the two queries above, and the same mock gap: the mock matches
 * `/api/claude/usage` by prefix, so this path can come back as an `AccountUsage[]`. Coerce anything
 * without a `total` to the empty shape so the card renders its empty state instead of crashing.
 */
export function usageTotalsQuery(client: DashboardClient, minutes: number) {
    return queryOptions<UsageTotalsResult>({
        queryKey: claudeUsageKeys.totals(minutes),
        queryFn: async () => {
            const result = await client.get<UsageTotalsResult>(paths.claudeUsageTotals(minutes));

            if (result && typeof result === "object" && typeof (result as UsageTotalsResult).total === "object") {
                return result;
            }

            return emptyTotals();
        },
        refetchInterval: USAGE_INTERVAL_MS,
    });
}
