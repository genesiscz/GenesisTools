import type { AccountUsage } from "@app/claude/lib/usage/api";
import { UsageHistoryDb } from "@app/claude/lib/usage/history-db";
import { getSharedAccountsUsage } from "@app/claude/lib/usage/shared-cache";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { showsInUsageDashboard } from "@genesiscz/utils/ai/config/selectors";
import { queryUsage } from "@genesiscz/utils/ai/usage";
import { logger } from "@genesiscz/utils/logger";
import type { AccountTotals, MultiBucketHistoryResult, UsageHistoryResult, UsageTotalsResult } from "./types";

/**
 * The usage tab reads two stores on purpose.
 *
 * Subscription LIMIT BUCKETS (5h / 7-day / per-model utilization percentages)
 * come from claude's own `UsageHistoryDb` — `getCurrentUsage` and the history
 * functions below. They are the Anthropic usage endpoint's own numbers, they
 * have no token counts, and nothing in the shared layer can reconstruct them.
 *
 * TOKEN AND COST TOTALS come from the shared usage layer (`getUsageTotals`),
 * which sees every surface (ask, ai-proxy, youtube, …), not just Claude. That is
 * the whole point of L7: the bucket says how close to a ceiling you are, the
 * totals say what was actually spent getting there.
 */

export function getCurrentUsage(): Promise<AccountUsage[]> {
    return getSharedAccountsUsage();
}

/**
 * Cross-surface token and cost totals for the last `minutes`.
 *
 * Rows are read unfiltered and grouped afterwards rather than queried per
 * account, so usage attributed to an account the dashboard does not show (a
 * renamed account, another machine's rows, a `free`-billing account) still
 * appears — as an `unknown: false` group — instead of vanishing from a total
 * that claims to be complete.
 */
export async function getUsageTotals(opts: { minutes: number }): Promise<UsageTotalsResult> {
    const now = Date.now();
    // `queryUsage`'s upper bound is EXCLUSIVE. Ending the window at exactly `now`
    // drops any call recorded in this very millisecond, which is precisely the
    // call a user just made and is refreshing to see.
    const to = new Date(now + 1);
    const from = new Date(now - opts.minutes * 60_000);
    const result = queryUsage({ from: from.toISOString(), to: to.toISOString() });
    const shown = await shownAccounts();
    const accounts: AccountTotals[] = Object.entries(result.byAccount)
        .map(([key, totals]) => {
            const account = shown.get(key);

            return {
                key,
                name: account?.name ?? key,
                ...(account?.label ? { label: account.label } : {}),
                known: account !== undefined,
                totals,
            };
        })
        .sort((a, b) => b.totals.costUsd - a.totals.costUsd);

    return {
        from: from.toISOString(),
        to: to.toISOString(),
        total: result.total,
        accounts,
        byApp: result.byApp,
    };
}

/**
 * Accounts the usage dashboard is allowed to name, keyed by BOTH id and name.
 *
 * Two keys because emitters differ in what they know: the core call path records
 * an `acc_…` id, while a poller that could not resolve one falls back to the
 * account's name. Indexing both means the same account does not render twice.
 */
async function shownAccounts(): Promise<Map<string, { name: string; label?: string }>> {
    const map = new Map<string, { name: string; label?: string }>();

    try {
        const store = await AiConfigStore.load();

        for (const account of store.accounts()) {
            if (!showsInUsageDashboard(account)) {
                continue;
            }

            const entry = { name: account.name, ...(account.label ? { label: account.label } : {}) };
            map.set(account.id, entry);
            map.set(account.name, entry);
        }
    } catch (err) {
        logger.warn({ err }, "usage totals: account list unavailable; rendering raw keys");
    }

    return map;
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
