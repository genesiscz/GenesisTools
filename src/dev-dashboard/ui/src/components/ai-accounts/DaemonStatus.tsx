import type { AiDaemonStatus } from "@app/dev-dashboard/contract/ai-accounts";
import { formatRelativeTime } from "@genesiscz/utils/format";
import { PROVIDER_META } from "@/lib/provider-meta";
import { ProviderBadge } from "./ProviderBadge";

interface DaemonStatusProps {
    status?: AiDaemonStatus;
    loading: boolean;
    refreshing: boolean;
    registering: boolean;
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

/** Polling health: is the task registered, when did it run, how fresh is each provider. */
export function DaemonStatus({ status, loading, refreshing, registering, onRefresh, onRegister }: DaemonStatusProps) {
    const registered = status?.registered ?? false;

    return (
        <div className="dd-panel dd-ai-fade-up flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <h3 className="dd-accent-text text-sm font-semibold">Polling</h3>
                    {loading ? (
                        <div className="dd-ai-skeleton h-3 w-40" />
                    ) : (
                        <span className="text-xs text-[var(--dd-text-muted)]">
                            {registered
                                ? `task ${status?.taskName ?? "ai-usage-poll"}, last run ${ago(status?.lastRunAt)}`
                                : "no daemon task registered; usage refreshes only when a page or the TUI is open"}
                        </span>
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
                    const tone = p?.error
                        ? "var(--dd-danger)"
                        : (p?.ageSec ?? 0) > 600
                          ? "var(--dd-warning)"
                          : "var(--dd-text-muted)";

                    return (
                        <div
                            key={meta.id}
                            className="flex items-center justify-between rounded-md border border-[var(--dd-border)] px-3 py-2"
                        >
                            <ProviderBadge provider={meta.id} />
                            {loading ? (
                                <div className="dd-ai-skeleton h-3 w-16" />
                            ) : (
                                <span className="dd-ai-mono text-xs" style={{ color: tone }} title={p?.error}>
                                    {p?.error ? "error" : p ? `fetched ${ago(p.lastFetchAt)}` : "not polled"}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
