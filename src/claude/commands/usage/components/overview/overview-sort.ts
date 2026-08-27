import { scoreAccounts, sortGrouped } from "@app/claude/lib/usage/account-picker";
import type { AccountUsage } from "@app/claude/lib/usage/api";

/** `config` keeps the poller order; `urgency` is the same grouping `tools claude run` uses. */
export type OverviewSortMode = "config" | "urgency";

/** Reorder by the shared grouped-urgency scoring. Default matches the cc run picker. */
export function applySort(accounts: AccountUsage[], mode: OverviewSortMode = "urgency"): AccountUsage[] {
    if (mode === "config") {
        return accounts;
    }

    const byName = new Map(accounts.map((a) => [a.accountName, a]));

    return sortGrouped(scoreAccounts(accounts))
        .map((scored) => byName.get(scored.accountName))
        .filter((account): account is AccountUsage => account !== undefined);
}
