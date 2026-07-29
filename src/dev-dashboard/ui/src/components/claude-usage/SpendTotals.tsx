import type { UsageTotalsResult } from "@app/dev-dashboard/lib/claude-usage/types";
import { formatNumber, formatTokens } from "@genesiscz/utils/format";

interface SpendTotalsProps {
    totals: UsageTotalsResult;
}

function formatUsd(value: number): string {
    if (value === 0) {
        return "$0";
    }

    return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-[var(--dd-text-muted)]">{label}</span>
            <span className="text-lg font-semibold text-[var(--dd-text-primary)]">{value}</span>
            {hint ? <span className="text-xs text-[var(--dd-text-muted)]">{hint}</span> : null}
        </div>
    );
}

/**
 * Cross-surface token/cost totals from the shared usage layer.
 *
 * Deliberately separate from the bucket cards above it: those are Anthropic's
 * subscription limit percentages, these are what every surface actually spent.
 * `unpriced` is surfaced rather than folded into the cost, because a model with
 * no known rate makes the total a floor, not an answer.
 */
export function SpendTotals({ totals }: SpendTotalsProps) {
    const { total, accounts, byApp } = totals;

    if (total.events === 0) {
        return (
            <div className="dd-panel flex flex-col gap-1 p-4">
                <h3 className="dd-accent-text text-sm font-semibold">Recorded spend</h3>
                <p className="text-sm text-[var(--dd-text-muted)]">
                    No usage events in this window yet. Rows appear as tools make calls.
                </p>
            </div>
        );
    }

    const apps = Object.entries(byApp).sort((a, b) => b[1].events - a[1].events);

    return (
        <div className="dd-panel flex flex-col gap-4 p-4">
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="dd-accent-text text-sm font-semibold">Recorded spend</h3>
                <span className="text-xs text-[var(--dd-text-muted)]">
                    {apps.map(([app, aggregate]) => `${app} ${formatNumber(aggregate.events)}`).join(" · ")}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <Stat label="Cost" value={formatUsd(total.costUsd)} hint={unpricedHint(total.unpricedEvents)} />
                <Stat label="Calls" value={formatNumber(total.events)} />
                <Stat label="Input" value={formatTokens(total.inputTokens)} />
                <Stat label="Output" value={formatTokens(total.outputTokens)} />
            </div>

            {accounts.length > 0 ? (
                <div className="flex flex-col gap-2">
                    {accounts.map((account) => (
                        <div key={account.key} className="flex items-baseline justify-between gap-3 text-sm">
                            <span
                                className={
                                    account.known
                                        ? "text-[var(--dd-text-secondary)]"
                                        : "text-[var(--dd-text-muted)] italic"
                                }
                            >
                                {account.label ? `${account.name} (${account.label})` : account.name}
                            </span>
                            <span className="font-mono text-xs text-[var(--dd-text-muted)]">
                                {formatUsd(account.totals.costUsd)} ·{" "}
                                {formatTokens(account.totals.inputTokens + account.totals.outputTokens)}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function unpricedHint(unpriced: number): string | undefined {
    if (unpriced === 0) {
        return undefined;
    }

    return `${formatNumber(unpriced)} call${unpriced === 1 ? "" : "s"} with no known rate`;
}
