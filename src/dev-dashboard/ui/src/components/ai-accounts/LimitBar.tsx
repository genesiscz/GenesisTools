import type { LimitWindow } from "@app/dev-dashboard/contract/ai-accounts";

interface LimitBarProps {
    window: LimitWindow;
    /** Injected so a list renders a consistent "now" and tests are deterministic. */
    nowMs: number;
}

export function limitColor(window: LimitWindow): string {
    if (window.severity === "critical" || window.percentUsed > 85) {
        return "var(--dd-danger)";
    }

    if (window.severity === "warn" || window.percentUsed >= 60) {
        return "var(--dd-warning)";
    }

    return "var(--dd-accent-from)";
}

export function formatResetsIn(resetsAt: string | undefined, nowMs: number): string | null {
    if (!resetsAt) {
        return null;
    }

    const diffMs = new Date(resetsAt).getTime() - nowMs;

    if (Number.isNaN(diffMs) || diffMs <= 0) {
        return null;
    }

    const totalMinutes = Math.floor(diffMs / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `resets in ${days}d ${hours}h`;
    }

    return `resets in ${hours}h ${minutes}m`;
}

export function formatMoney(money: NonNullable<LimitWindow["money"]>): string {
    const scale = 10 ** money.exponent;
    const used = (money.usedMinor / scale).toFixed(2);
    const symbol = money.currency === "USD" ? "$" : `${money.currency} `;

    if (money.limitMinor === undefined) {
        return `${symbol}${used}`;
    }

    return `${symbol}${used} / ${symbol}${(money.limitMinor / scale).toFixed(2)}`;
}

/** One provider-neutral limit row: label, value, bar, reset hint. */
export function LimitBar({ window, nowMs }: LimitBarProps) {
    const pct = Math.max(0, Math.min(100, window.percentUsed));
    const color = limitColor(window);
    const resetsIn = formatResetsIn(window.resetsAt, nowMs);
    const untouched = !window.resetsAt && window.percentUsed === 0 && !window.money;
    const label =
        window.scopeModel && !window.label.includes(window.scopeModel)
            ? `${window.label} ${window.scopeModel}`
            : window.label;
    const value = window.money ? formatMoney(window.money) : `${window.percentUsed.toFixed(0)}%`;

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-sm">
                <span className="text-[var(--dd-text-secondary)]">
                    {label}
                    {window.isActive === false ? (
                        <span className="ml-2 text-xs text-[var(--dd-text-muted)]">inactive</span>
                    ) : null}
                </span>
                <span className="dd-ai-mono text-[var(--dd-text-primary)]">{value}</span>
            </div>
            <div className="dd-ai-bar">
                <span style={{ transform: `scaleX(${pct / 100})`, backgroundColor: color }} />
            </div>
            {untouched ? (
                <span className="text-xs text-[var(--dd-text-muted)]">Not used</span>
            ) : resetsIn ? (
                <span className="text-xs text-[var(--dd-text-muted)]">{resetsIn}</span>
            ) : null}
        </div>
    );
}
