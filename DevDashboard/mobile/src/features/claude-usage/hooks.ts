import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "@/api/client-provider";
import { usageAccountsQuery, usageHistoryQuery } from "@/features/claude-usage/queries";

/**
 * Component-facing claude-usage hooks (D32). Components import THESE — never raw `useQuery`. Each is
 * a one-liner over the active client from the provider, so the mock↔real swap stays invisible.
 *
 * ► REFERENCE SHAPE: `export const useX = () => useQuery(xQuery(useDashboardClient()));`
 */

export function useUsageAccounts() {
    return useQuery(usageAccountsQuery(useDashboardClient()));
}

export function useUsageHistory(account: string, minutes: number) {
    return useQuery(usageHistoryQuery(useDashboardClient(), account, minutes));
}
