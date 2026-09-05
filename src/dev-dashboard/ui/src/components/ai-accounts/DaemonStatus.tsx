import type { AiDaemonStatus } from "@app/dev-dashboard/contract/ai-accounts";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { PROVIDER_META } from "@/lib/provider-meta";
import { ProviderBadge } from "./ProviderBadge";

interface DaemonStatusProps {
    status?: AiDaemonStatus;
    loading: boolean;
    refreshing: boolean;
    registering: boolean;
    /** Configured accounts per plugin id, so a provider with none says so instead of "never". */
    accountCounts: Record<string, number>;
    onRefresh: () => void;
    onRegister: () => void;
}

function ago(iso: string | undefined): string {
    if (!iso) {
        return "never";
    }

    const d = new Date(iso);

    if (Number.isNaN(d.getTime())) {
        return "unknown";
    }

    return formatRelativeTime(d, { compact: true });
}

/**
 * `formatRelativeTime` only looks backwards, and the daemon's next run is often
 * already overdue: it is derived from the last run's start, so a run that took
 * longer than the interval leaves the advertised time in the past.
 */
function until(iso: string | undefined, nowMs: number): string | null {
    if (!iso) {
        return null;
    }

    const ms = new Date(iso).getTime();

    if (Number.isNaN(ms)) {
        return null;
    }

    const seconds = Math.round((ms - nowMs) / 1000);

    if (seconds <= 0) {
        return "due";
    }

    if (seconds < 60) {
        return `in ${seconds}s`;
    }

    return `in ${Math.round(seconds / 60)}m`;
}

/** Polling health: is the task registered, when did it run, how fresh is each provider. */
export function DaemonStatus({
    status,
    loading,
    refreshing,
    registering,
    accountCounts,
    onRefresh,
    onRegister,
}: DaemonStatusProps) {
    const registered = status?.registered ?? false;
    const nextRun = until(status?.nextRunAt, Date.now());
    const schedule = registered
        ? `task ${status?.taskName ?? "ai-usage-poll"}, last run ${ago(status?.lastRunAt)}${
              nextRun ? `, next run ${nextRun}` : ""
          }`
        : "no daemon task registered; usage refreshes only when a page or the TUI is open";

    return (
        <div className="dd-panel dd-ai-fade-up flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h3 className="dd-accent-text text-sm font-semibold">Polling</h3>
                    {loading ? (
                        <div className="dd-ai-skeleton h-3 w-40" />
                    ) : (
                        <span className="text-xs text-[var(--dd-text-muted)]">{schedule}</span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {!registered && !loading ? (
                        <button
                            type="button"
                            className="dd-ai-action-ghost"
                            disabled={registering}
                            onClick={onRegister}
                        >
                            {registering ? "Registering" : "Register daemon"}
                        </button>
                    ) : null}
                    <button type="button" className="dd-ai-action" disabled={refreshing} onClick={onRefresh}>
                        {refreshing ? "Refreshing" : "Refresh now"}
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {PROVIDER_META.map((meta) => {
                    const p = status?.perProvider[meta.id];
                    const configured = (accountCounts[meta.id] ?? 0) > 0;
                    const tone = p?.error
                        ? "var(--dd-danger)"
                        : !configured
                          ? "var(--dd-text-muted)"
                          : (p?.ageSec ?? 0) > 600 || !p?.lastFetchAt
                            ? "var(--dd-warning)"
                            : "var(--dd-text-muted)";
                    const label = p?.error
                        ? "error"
                        : !configured
                          ? "no account"
                          : p?.lastFetchAt
                            ? `fetched ${ago(p.lastFetchAt)}`
                            : "not polled yet";

                    return (
                        <div
                            key={meta.id}
                            className="flex flex-col gap-1 rounded-md border border-[var(--dd-border)] px-3 py-2"
                        >
                            <div className="flex items-center justify-between gap-2">
                                <ProviderBadge provider={meta.id} />
                                {loading ? (
                                    <div className="dd-ai-skeleton h-3 w-16" />
                                ) : (
                                    <span className="dd-ai-mono text-xs" style={{ color: tone }}>
                                        {label}
                                    </span>
                                )}
                            </div>
                            {!loading && p?.error ? (
                                <p
                                    className="dd-ai-mono break-words text-[11px] leading-snug text-[var(--dd-text-muted)]"
                                    title={p.error}
                                >
                                    {p.error}
                                </p>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
