import {
    type AccountRef,
    AI_ACCOUNTS_API,
    type AiAccountsResult,
    type AiDaemonStatus,
    type AiSpendSeriesResult,
    type AiSpendTotalsResult,
    type AiUsageResult,
    type AiUsageSeriesResult,
    type SpendSource,
} from "@app/dev-dashboard/contract/ai-accounts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AccountCard } from "@/components/ai-accounts/AccountCard";
import { DaemonStatus } from "@/components/ai-accounts/DaemonStatus";
import { FilterBar } from "@/components/ai-accounts/FilterBar";
import { LimitsChart } from "@/components/ai-accounts/LimitsChart";
import { MosaicBlocks } from "@/components/ai-accounts/MosaicBlocks";
import { RecordedSpend } from "@/components/ai-accounts/RecordedSpend";
import { SortableBlocks } from "@/components/ai-accounts/SortableBlocks";
import "@/components/ai-accounts/ai-accounts.css";
import { useAiAccountsFilters, useSpendHiddenAccounts } from "@/hooks/useAiAccountsFilters";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useMosaicLayout } from "@/hooks/useMosaicLayout";
import { useSectionLayout } from "@/hooks/useSectionLayout";
import { assignAccountColors } from "@/lib/account-color";
import { grainForMinutes, resolveRange } from "@/lib/ai-accounts-filters";
import { fetchJson } from "@/lib/api";
import { providerOrder } from "@/lib/provider-meta";
import type { SpendChartMode } from "@/lib/spend-chart-data";

const BLOCKS = ["filters", "accounts", "spend", "limits", "daemon"] as const;
const BLOCK_LABELS: Record<string, string> = {
    filters: "Filters",
    accounts: "Accounts",
    spend: "Recorded spend",
    limits: "Limits over time",
    daemon: "Polling",
};
const LAYOUT_KEY = "dd:ai-accounts:layout";
const MOSAIC_KEY = "dd:ai-accounts:mosaic";

function query(params: Record<string, string | undefined>): string {
    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            search.set(key, value);
        }
    }

    const text = search.toString();
    return text ? `?${text}` : "";
}

/**
 * /ai/accounts: every provider's accounts, their limit windows, recorded spend and polling
 * health. Desktop lays the blocks out as react-mosaic tiles (drag to move, drag splits to
 * resize, hide from the toolbar), the same mechanism as the ttyd and cmux pages; the focused
 * mode used on mobile stacks them with move and hide buttons. Not yet registered in the
 * router: the server routes it calls land with Plan-Dashboard.
 */
export function AiAccountsRoute() {
    const queryClient = useQueryClient();
    const { filters, toggleProvider, toggleAccount, setAccounts, setRange, reset } = useAiAccountsFilters();
    const { hiddenSet, toggleHidden, showAll } = useSpendHiddenAccounts();
    const { mode, isMobile, setMode } = useLayoutMode("ai-accounts");
    const list = useSectionLayout(LAYOUT_KEY, BLOCKS);
    const mosaic = useMosaicLayout(MOSAIC_KEY, BLOCKS, 2);
    const [source, setSource] = useState<SpendSource>("transcripts");
    const [chartMode, setChartMode] = useState<SpendChartMode>("stacked");

    const providersParam = filters.providers.join(",");
    const accountsParam = filters.accountIds.join(",");

    const accountsQuery = useQuery({
        queryKey: ["ai", "accounts"],
        queryFn: () => fetchJson<AiAccountsResult>(AI_ACCOUNTS_API.accounts),
        refetchInterval: 60000,
    });
    const usageQuery = useQuery({
        queryKey: ["ai", "usage", providersParam, accountsParam],
        queryFn: () =>
            fetchJson<AiUsageResult>(
                `${AI_ACCOUNTS_API.usage}${query({ providers: providersParam, accounts: accountsParam })}`
            ),
        refetchInterval: 60000,
    });

    // One window end shared by every query and chart so their axes align; it moves
    // on a filter change or a usage tick, not on every render.
    const rangeEndMs = useMemo(() => Date.now(), [filters.range, usageQuery.dataUpdatedAt]);
    const range = useMemo(() => resolveRange(filters.range, rangeEndMs), [filters.range, rangeEndMs]);
    const grain = grainForMinutes(range.minutes);
    const fromIso = new Date(range.fromMs).toISOString();
    const toIso = new Date(range.toMs).toISOString();

    const totalsQuery = useQuery({
        queryKey: ["ai", "spend", "totals", fromIso, toIso, source, accountsParam],
        queryFn: () =>
            fetchJson<AiSpendTotalsResult>(
                `${AI_ACCOUNTS_API.spendTotals}${query({ from: fromIso, to: toIso, source, accounts: accountsParam })}`
            ),
        refetchInterval: 60000,
    });
    const spendSeriesQuery = useQuery({
        queryKey: ["ai", "spend", "series", fromIso, toIso, grain, source, accountsParam],
        queryFn: () =>
            fetchJson<AiSpendSeriesResult>(
                `${AI_ACCOUNTS_API.spendSeries}${query({ from: fromIso, to: toIso, grain, source, accounts: accountsParam })}`
            ),
        refetchInterval: 60000,
    });
    const limitsSeriesQuery = useQuery({
        queryKey: ["ai", "usage", "series", fromIso, toIso, providersParam, accountsParam],
        queryFn: () =>
            fetchJson<AiUsageSeriesResult>(
                `${AI_ACCOUNTS_API.usageSeries}${query({
                    from: fromIso,
                    to: toIso,
                    providers: providersParam,
                    accounts: accountsParam,
                })}`
            ),
        refetchInterval: 60000,
    });
    const daemonQuery = useQuery({
        queryKey: ["ai", "daemon"],
        queryFn: () => fetchJson<AiDaemonStatus>(AI_ACCOUNTS_API.daemon),
        refetchInterval: 30000,
    });

    const refresh = useMutation({
        mutationFn: () => fetchJson<AiUsageResult>(AI_ACCOUNTS_API.usageRefresh, { method: "POST" }),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["ai", "usage"] });
            void queryClient.invalidateQueries({ queryKey: ["ai", "daemon"] });
        },
    });
    const register = useMutation({
        mutationFn: () => fetchJson<{ ok: boolean }>(AI_ACCOUNTS_API.daemonRegister, { method: "POST" }),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ai", "daemon"] }),
    });

    const accountRefs: AccountRef[] = useMemo(
        () =>
            (accountsQuery.data?.accounts ?? [])
                .map((a) => ({ accountId: a.id, accountName: a.name, provider: a.provider, label: a.label }))
                .sort(
                    (a, b) =>
                        providerOrder(a.provider) - providerOrder(b.provider) ||
                        a.accountName.localeCompare(b.accountName)
                ),
        [accountsQuery.data]
    );
    const colors = useMemo(() => assignAccountColors(accountRefs.map((a) => a.accountId)), [accountRefs]);

    const snapshots = useMemo(
        () =>
            [...(usageQuery.data?.snapshots ?? [])].sort(
                (a, b) =>
                    providerOrder(a.provider) - providerOrder(b.provider) || a.accountName.localeCompare(b.accountName)
            ),
        [usageQuery.data]
    );

    const renderBlock = (id: string) => {
        switch (id) {
            case "filters":
                return (
                    <FilterBar
                        filters={filters}
                        accounts={accountRefs}
                        colors={colors}
                        onToggleProvider={toggleProvider}
                        onToggleAccount={toggleAccount}
                        onSetAccounts={setAccounts}
                        onSetRange={setRange}
                        onReset={reset}
                    />
                );
            case "accounts":
                if (usageQuery.isLoading) {
                    return (
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
                            {[0, 1, 2].map((i) => (
                                <div key={i} className="dd-panel flex flex-col gap-3 p-4">
                                    <div className="dd-ai-skeleton h-5 w-32" />
                                    <div className="dd-ai-skeleton h-3 w-full" />
                                    <div className="dd-ai-skeleton h-3 w-full" />
                                </div>
                            ))}
                        </div>
                    );
                }

                if (snapshots.length === 0) {
                    return (
                        <div className="dd-panel flex flex-col items-center gap-2 p-8 text-center">
                            <p className="text-sm text-[var(--dd-text-primary)]">No accounts match the filters.</p>
                            <p className="text-xs text-[var(--dd-text-muted)]">
                                Add one with{" "}
                                <code className="dd-ai-mono">tools ai accounts login --provider claude|codex|grok</code>
                                .
                            </p>
                        </div>
                    );
                }

                return (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {snapshots.map((snapshot, index) => (
                            <AccountCard
                                key={snapshot.accountId}
                                snapshot={snapshot}
                                color={colors[snapshot.accountId] ?? "var(--dd-accent-from)"}
                                nowMs={rangeEndMs}
                                index={index}
                            />
                        ))}
                    </div>
                );
            case "spend":
                return (
                    <RecordedSpend
                        totals={totalsQuery.data}
                        series={spendSeriesQuery.data}
                        loading={totalsQuery.isLoading || spendSeriesQuery.isLoading}
                        error={totalsQuery.error?.message ?? spendSeriesQuery.error?.message}
                        windowLabel={range.label}
                        rangeStartMs={range.fromMs}
                        rangeEndMs={range.toMs}
                        grain={grain}
                        source={source}
                        onSourceChange={setSource}
                        mode={chartMode}
                        onModeChange={setChartMode}
                        hiddenAccountIds={hiddenSet}
                        onToggleAccount={toggleHidden}
                        onShowAll={showAll}
                        colors={colors}
                    />
                );
            case "limits":
                return (
                    <LimitsChart
                        title="Limits over time"
                        series={limitsSeriesQuery.data?.series ?? []}
                        colors={colors}
                        rangeMinutes={range.minutes}
                        rangeEndMs={range.toMs}
                        loading={limitsSeriesQuery.isLoading}
                        hint="History appears once the poller has run a few times."
                    />
                );
            case "daemon":
                return (
                    <DaemonStatus
                        status={daemonQuery.data}
                        loading={daemonQuery.isLoading}
                        refreshing={refresh.isPending}
                        registering={register.isPending}
                        onRefresh={() => refresh.mutate()}
                        onRegister={() => register.mutate()}
                    />
                );
            default:
                return null;
        }
    };

    const tiled = mode === "mosaic";

    return (
        <div className={tiled ? "flex h-[calc(100vh-2rem)] flex-col gap-3" : "flex flex-col gap-4"}>
            <div className="flex items-baseline justify-between">
                <h2 className="dd-accent-text text-xl font-bold">AI accounts</h2>
                <div className="flex items-center gap-3">
                    {usageQuery.data ? (
                        <span className="dd-ai-mono text-xs text-[var(--dd-text-muted)]">
                            {snapshots.length} account{snapshots.length === 1 ? "" : "s"}
                        </span>
                    ) : null}
                    {!isMobile ? (
                        <button
                            type="button"
                            className="dd-ai-action-ghost"
                            onClick={() => setMode(tiled ? "focused" : "mosaic")}
                        >
                            {tiled ? "Focused" : "Mosaic"}
                        </button>
                    ) : null}
                </div>
            </div>
            {tiled ? (
                <MosaicBlocks
                    node={mosaic.node}
                    onChange={mosaic.setNode}
                    labels={BLOCK_LABELS}
                    hidden={mosaic.hidden}
                    onHide={mosaic.hide}
                    onShow={mosaic.show}
                    onReset={mosaic.reset}
                    render={renderBlock}
                />
            ) : (
                <SortableBlocks
                    layout={list.layout}
                    labels={BLOCK_LABELS}
                    onMove={list.move}
                    onHide={list.hide}
                    onShow={list.show}
                    onReset={list.reset}
                    render={renderBlock}
                />
            )}
        </div>
    );
}
