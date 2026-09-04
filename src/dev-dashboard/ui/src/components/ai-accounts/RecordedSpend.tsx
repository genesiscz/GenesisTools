import type {
    AccountRef,
    AiSpendSeriesResult,
    AiSpendTotalsResult,
    SpendGrain,
    SpendSource,
} from "@app/dev-dashboard/contract/ai-accounts";
import { formatNumber, formatTokens } from "@genesiscz/utils/format";
import { IconTooltip } from "@ui/components/icon-button";
import { SegmentedControl } from "@ui/components/segmented-control";
import { CircleHelp } from "lucide-react";
import { providerMeta } from "@/lib/provider-meta";
import { formatUsd, SPEND_CHART_MODES, type SpendChartMode, sumVisible } from "@/lib/spend-chart-data";
import { ProviderBadge } from "./ProviderBadge";
import { SpendChart } from "./SpendChart";

interface RecordedSpendProps {
    totals?: AiSpendTotalsResult;
    series?: AiSpendSeriesResult;
    loading: boolean;
    error?: string;
    /** Human window label from `resolveRange`. */
    windowLabel: string;
    rangeStartMs: number;
    rangeEndMs: number;
    grain: SpendGrain;
    source: SpendSource;
    onSourceChange: (source: SpendSource) => void;
    mode: SpendChartMode;
    onModeChange: (mode: SpendChartMode) => void;
    hiddenAccountIds: ReadonlySet<string>;
    onToggleAccount: (accountId: string) => void;
    onShowAll: () => void;
    colors: Record<string, string>;
}

const SOURCE_OPTIONS: ReadonlyArray<{ value: SpendSource; label: string }> = [
    { value: "transcripts", label: "Transcripts" },
    { value: "calls", label: "Calls" },
    { value: "both", label: "Both" },
];

const SOURCE_HELP =
    "Transcripts: cost rebuilt from the coding agents' own session logs on disk (what tools ai-spend and the " +
    "Genesis menubar show). Calls: every inference call GenesisTools itself made (ask, ai-proxy, youtube). " +
    "Both: the two added together.";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-[var(--dd-text-muted)]">{label}</span>
            <span className="dd-ai-mono text-lg font-semibold text-[var(--dd-text-primary)]">{value}</span>
            {hint ? <span className="text-xs text-[var(--dd-text-muted)]">{hint}</span> : null}
        </div>
    );
}

function SkeletonRows() {
    return (
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading spend">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex flex-col gap-2">
                        <div className="dd-ai-skeleton h-3 w-12" />
                        <div className="dd-ai-skeleton h-6 w-20" />
                    </div>
                ))}
            </div>
            <div className="dd-ai-skeleton h-40 w-full" />
        </div>
    );
}

/**
 * Cost over a stated window, per account, with a chart. The window label is
 * part of the widget so a number never appears without its time frame.
 */
export function RecordedSpend({
    totals,
    series,
    loading,
    error,
    windowLabel,
    rangeStartMs,
    rangeEndMs,
    grain,
    source,
    onSourceChange,
    mode,
    onModeChange,
    hiddenAccountIds,
    onToggleAccount,
    onShowAll,
    colors,
}: RecordedSpendProps) {
    const accounts: AccountRef[] = totals?.accounts ?? series?.accounts ?? [];
    const visible = series ? sumVisible(series.points, hiddenAccountIds) : undefined;
    const shownTotal = visible ?? totals?.total;
    const unpriced = totals?.unpriced ?? series?.unpriced ?? 0;
    const empty = !loading && !error && (totals?.total.costUsd ?? 0) === 0 && (series?.points.length ?? 0) === 0;
    const costOf = (accountId: string): number => totals?.accounts.find((x) => x.accountId === accountId)?.costUsd ?? 0;
    const sortedAccounts = [...accounts].sort((a, b) => costOf(b.accountId) - costOf(a.accountId));
    // Share bars read against the biggest account, not the total: with one
    // account at 97% every other bar would be an invisible sliver.
    const topCost = sortedAccounts.length > 0 ? costOf(sortedAccounts[0].accountId) : 0;

    return (
        <div className="dd-panel dd-ai-fade-up flex flex-col gap-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <h3 className="dd-accent-text text-sm font-semibold">Recorded spend</h3>
                        <IconTooltip tooltip={SOURCE_HELP}>
                            <span className="text-[var(--dd-text-muted)]" aria-label="What the sources mean">
                                <CircleHelp size={14} />
                            </span>
                        </IconTooltip>
                    </div>
                    <span className="dd-ai-mono text-xs text-[var(--dd-text-muted)]">{windowLabel}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <SegmentedControl<SpendSource>
                        tone="dd"
                        aria-label="Spend source"
                        className="w-auto"
                        value={source}
                        onValueChange={onSourceChange}
                        options={SOURCE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    />
                    <SegmentedControl<SpendChartMode>
                        tone="dd"
                        aria-label="Chart mode"
                        className="w-auto"
                        value={mode}
                        onValueChange={onModeChange}
                        options={SPEND_CHART_MODES.map((m) => ({ value: m.value, label: m.label }))}
                    />
                </div>
            </div>

            {loading ? <SkeletonRows /> : null}

            {error ? (
                <div className="flex flex-col gap-1 text-sm">
                    <p className="font-medium text-[var(--dd-danger)]">Spend unavailable</p>
                    <p className="break-words font-mono text-xs text-[var(--dd-text-muted)]">{error}</p>
                </div>
            ) : null}

            {empty ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <p className="text-sm text-[var(--dd-text-primary)]">Nothing recorded in this window.</p>
                    <p className="text-xs text-[var(--dd-text-muted)]">
                        Widen the range, switch the source, or check the accounts above.
                    </p>
                    {hiddenAccountIds.size > 0 ? (
                        <button type="button" className="dd-ai-action-ghost" onClick={onShowAll}>
                            Show all accounts
                        </button>
                    ) : null}
                </div>
            ) : null}

            {!loading && !error && !empty && shownTotal ? (
                <>
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                        <Stat
                            label="Cost"
                            value={formatUsd(shownTotal.costUsd)}
                            hint={unpriced > 0 ? `${formatNumber(unpriced)} unpriced` : undefined}
                        />
                        <Stat label="Tokens" value={formatTokens(shownTotal.tokens)} />
                        <Stat label="Accounts" value={String(accounts.length - hiddenAccountIds.size)} />
                        <Stat label="Source" value={SOURCE_OPTIONS.find((o) => o.value === source)?.label ?? source} />
                    </div>

                    {sortedAccounts.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                            {sortedAccounts.map((account) => {
                                const row = totals?.accounts.find((x) => x.accountId === account.accountId);
                                const name = account.label
                                    ? `${account.accountName} (${account.label})`
                                    : account.accountName;
                                const color = colors[account.accountId] ?? providerMeta(account.provider).color;
                                const share = topCost > 0 ? ((row?.costUsd ?? 0) / topCost) * 100 : 0;

                                return (
                                    <button
                                        key={account.accountId}
                                        type="button"
                                        className="dd-ai-spend-row"
                                        aria-pressed={!hiddenAccountIds.has(account.accountId)}
                                        title={`${providerMeta(account.provider).displayName}: ${account.accountId}`}
                                        style={{ "--chip-color": color } as React.CSSProperties}
                                        onClick={() => onToggleAccount(account.accountId)}
                                    >
                                        <span className="dd-ai-dot" />
                                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--dd-text-primary)]">
                                            {name}
                                        </span>
                                        <ProviderBadge provider={account.provider} compact />
                                        <span className="dd-ai-mono w-16 text-right text-xs text-[var(--dd-text-primary)]">
                                            {formatUsd(row?.costUsd ?? 0)}
                                        </span>
                                        <span className="dd-ai-mono w-14 text-right text-xs text-[var(--dd-text-muted)]">
                                            {formatTokens(row?.tokens ?? 0)}
                                        </span>
                                        <span
                                            className="dd-ai-share w-14 sm:w-24"
                                            aria-hidden="true"
                                            title={`${share.toFixed(0)}% of the largest account`}
                                        >
                                            <span style={{ width: `${Math.min(100, share)}%`, background: color }} />
                                        </span>
                                    </button>
                                );
                            })}
                            {hiddenAccountIds.size > 0 ? (
                                <button
                                    type="button"
                                    className="self-start text-xs text-[var(--dd-text-muted)] underline-offset-2 hover:text-[var(--dd-text-primary)] hover:underline"
                                    onClick={onShowAll}
                                >
                                    show all
                                </button>
                            ) : null}
                        </div>
                    ) : null}

                    {series ? (
                        <SpendChart
                            points={series.points}
                            accounts={accounts}
                            colors={colors}
                            mode={mode}
                            hiddenAccountIds={hiddenAccountIds}
                            rangeStartMs={rangeStartMs}
                            rangeEndMs={rangeEndMs}
                            grain={grain}
                        />
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
