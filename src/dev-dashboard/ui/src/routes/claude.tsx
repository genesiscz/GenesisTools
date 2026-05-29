import type { AccountUsage } from "@app/claude/lib/usage/api";
import { useQuery } from "@tanstack/react-query";
import { SegmentedControl } from "@ui/components/segmented-control";
import { useMemo, useState } from "react";
import { AccountCard } from "@/components/claude-usage/AccountCard";
import { AccountUsageChart } from "@/components/claude-usage/AccountUsageChart";
import { fetchJson } from "@/lib/api";

const RANGES = [
    { label: "1h", minutes: 60 },
    { label: "24h", minutes: 1440 },
    { label: "7d", minutes: 10080 },
] as const;

export function ClaudeRoute() {
    const usageQuery = useQuery({
        queryKey: ["claude", "usage"],
        queryFn: () => fetchJson<AccountUsage[]>("/api/claude/usage"),
        refetchInterval: 30000,
    });
    const [rangeMinutes, setRangeMinutes] = useState<string>("10080");

    // One window end shared by every chart so their time axes align exactly.
    // Recomputed on each poll tick and on range change, not per chart render
    // (per-render Date.now() would drift the two charts apart again).
    const rangeEndMs = useMemo(() => Date.now(), [rangeMinutes, usageQuery.dataUpdatedAt]);

    const accounts = usageQuery.data ?? [];

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

            <div className="flex items-center justify-between">
                <h3 className="dd-accent-text text-sm font-semibold">Utilization history</h3>
                <SegmentedControl
                    tone="dd"
                    aria-label="History time range"
                    className="w-auto"
                    value={rangeMinutes}
                    onValueChange={setRangeMinutes}
                    options={RANGES.map((r) => ({
                        value: String(r.minutes),
                        label: r.label,
                    }))}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {accounts.map((account) => (
                    <AccountUsageChart
                        key={account.accountName}
                        accountName={account.accountName}
                        label={account.label}
                        accountError={account.error}
                        rangeMinutes={Number(rangeMinutes)}
                        rangeEndMs={rangeEndMs}
                    />
                ))}
            </div>
        </div>
    );
}
