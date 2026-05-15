import type { AccountUsage } from "@app/claude/lib/usage/api";
import type { UsageHistoryResult } from "@app/dev-dashboard/lib/claude-usage/types";
import { useQuery } from "@tanstack/react-query";
import { AccountCard } from "@/components/claude-usage/AccountCard";
import { UsageChart } from "@/components/claude-usage/UsageChart";

function fetchJson<T>(url: string): Promise<T> {
    return fetch(url).then((r) => r.json() as Promise<T>);
}

export function ClaudeRoute() {
    const usageQuery = useQuery({
        queryKey: ["claude", "usage"],
        queryFn: () => fetchJson<AccountUsage[]>("/api/claude/usage"),
        refetchInterval: 30000,
    });

    const accounts = usageQuery.data ?? [];
    const firstAccount = accounts[0];

    const historyQuery = useQuery({
        queryKey: ["claude", "usage", "history", firstAccount?.accountName],
        queryFn: () =>
            fetchJson<UsageHistoryResult>(
                `/api/claude/usage/history?account=${encodeURIComponent(firstAccount?.accountName ?? "")}&bucket=five_hour&minutes=1440`
            ),
        refetchInterval: 30000,
        enabled: Boolean(firstAccount),
    });

    if (usageQuery.isLoading) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center text-[var(--dd-text-muted)]">
                Loading Claude usage...
            </div>
        );
    }

    if (accounts.length === 0) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center text-[var(--dd-text-muted)]">
                No Claude subscription accounts configured.
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <h2 className="dd-accent-text text-xl font-bold">Claude Usage</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {accounts.map((account) => (
                    <AccountCard key={account.accountName} account={account} />
                ))}
            </div>
            {firstAccount ? (
                <UsageChart
                    snapshots={historyQuery.data?.snapshots ?? []}
                    hint={historyQuery.data?.hint}
                />
            ) : null}
        </div>
    );
}
