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
import { useEffect, useMemo, useState } from "react";
import { AccountCard } from "@/components/ai-accounts/AccountCard";
import { DaemonStatus } from "@/components/ai-accounts/DaemonStatus";
import { FilterBar } from "@/components/ai-accounts/FilterBar";
import { LimitsChart } from "@/components/ai-accounts/LimitsChart";
import { RecordedSpend } from "@/components/ai-accounts/RecordedSpend";
import { SortableBlockGrid } from "@/components/ai-accounts/SortableBlockGrid";
import { SortableBlocks } from "@/components/ai-accounts/SortableBlocks";
import "@/components/ai-accounts/ai-accounts.css";
import { useAiAccountsFilters, useSpendHiddenAccounts } from "@/hooks/useAiAccountsFilters";
import { useLayoutMode } from "@/hooks/useLayoutMode";
import { useLive } from "@/hooks/useLive";
import { useSectionLayout } from "@/hooks/useSectionLayout";
import { assignAccountColors } from "@/lib/account-color";
import { grainForMinutes, resolveStableRange, windowStepMs } from "@/lib/ai-accounts-filters";
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

/** How often the page re-reads the clock. The window itself only moves on its own step. */
const CLOCK_TICK_MS = 30_000;

/** A clock the render can depend on: countdowns stay live without a render loop. */
function useClockTick(everyMs: number): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(id);
    }, [everyMs]);

    return now;
}

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
 * health. Desktop lays the blocks out as a reorderable two-column grid (drag a block by its
 * grip, hide it from the same toolbar); the focused mode used on mobile stacks them with
 * move and hide buttons. Both modes read one persisted order, so switching keeps it.
 */
export function AiAccountsRoute() {
    // A poll started by the daemon happens in another process, so the server
    // learns about it from the cache file and forwards it here. Subscribing is
    // also what STARTS that producer: it is refcounted on demand.
    useLive(["ai-usage"]);

    const queryClient = useQueryClient();
    const { filters, toggleProvider, toggleAccount, setAccounts, setRange, reset } = useAiAccountsFilters();
    const { hiddenSet, toggleHidden, showAll } = useSpendHiddenAccounts();
    const { mode, isMobile, setMode } = useLayoutMode("ai-accounts");
    const list = useSectionLayout(LAYOUT_KEY, BLOCKS);
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

    // One window end shared by every query and chart so their axes align. It is
    // snapped to a step (a minute on an hour of data, fifteen on a month), so a
    // re-render and a refetch ask for the SAME window and hit the cache. Tying it
    // to `Date.now()` cost six spend requests over four windows a minute on an
    // idle page, each one a fresh transcript scan.
    const nowMs = useClockTick(CLOCK_TICK_MS);
    const range = useMemo(() => resolveStableRange(filters.range, nowMs), [filters.range, nowMs]);
    const grain = grainForMinutes(range.minutes);
    const fromIso = new Date(range.fromMs).toISOString();
    const toIso = new Date(range.toMs).toISOString();

    // Spend refetches at the cadence its window can actually move. A minute-by-minute
    // poll of a 30-day window re-ran a scan that could not have a different answer.
    const spendRefetchMs = windowStepMs(range.minutes);

    // A cold scan is slow, not broken, so one retry rides out a hiccup without
    // showing an error. React Query's default of three would queue up to four
    // scans of a window whose answer cannot change between them.
    const spendRetry = 1;

    // The provider chips narrow spend too: without them the widget kept reporting
    // claude money while the grid said "no accounts match the filters".
    const totalsQuery = useQuery({
        queryKey: ["ai", "spend", "totals", fromIso, toIso, source, providersParam, accountsParam],
        queryFn: () =>
            fetchJson<AiSpendTotalsResult>(
                `${AI_ACCOUNTS_API.spendTotals}${query({
                    from: fromIso,
                    to: toIso,
                    source,
                    providers: providersParam,
                    accounts: accountsParam,
                })}`
            ),
        refetchInterval: spendRefetchMs,
        retry: spendRetry,
    });
    const spendSeriesQuery = useQuery({
        queryKey: ["ai", "spend", "series", fromIso, toIso, grain, source, providersParam, accountsParam],
        queryFn: () =>
            fetchJson<AiSpendSeriesResult>(
                `${AI_ACCOUNTS_API.spendSeries}${query({
                    from: fromIso,
                    to: toIso,
                    grain,
                    source,
                    providers: providersParam,
                    accounts: accountsParam,
                })}`
            ),
        refetchInterval: spendRefetchMs,
        retry: spendRetry,
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
    const prominentByProvider = useMemo(
        () => new Map((accountsQuery.data?.providers ?? []).map((p) => [p.provider, p.prominentLimits])),
        [accountsQuery.data]
    );
    const accountCounts = useMemo(() => {
        const counts: Record<string, number> = {};

        for (const account of accountsQuery.data?.accounts ?? []) {
            counts[account.provider] = (counts[account.provider] ?? 0) + 1;
        }

        return counts;
    }, [accountsQuery.data]);

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
                                nowMs={nowMs}
                                prominentKeys={prominentByProvider.get(snapshot.provider)}
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
                        accountCounts={accountCounts}
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
        <div className="flex flex-col gap-4">
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
                            {tiled ? "Focused" : "Grid"}
                        </button>
                    ) : null}
                </div>
            </div>
            {tiled ? (
                <SortableBlockGrid
                    layout={list.layout}
                    labels={BLOCK_LABELS}
                    onReorder={list.reorder}
                    onHide={list.hide}
                    onShow={list.show}
                    onReset={list.reset}
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
