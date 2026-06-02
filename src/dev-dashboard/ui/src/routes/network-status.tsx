import type { NetStatus } from "@app/dev-dashboard/lib/net/types";
import { useQuery } from "@tanstack/react-query";
import { NetworkStatusCard } from "@/components/network-status/NetworkStatusCard";
import { fetchJson } from "@/lib/api";

/**
 * Network & Transport Status route — an at-a-glance HEALTH panel for the active link (latency +
 * quality + Wi-Fi/public IP), consuming the SAME `/api/net/status` endpoint the mobile screen uses.
 * Read-only diagnostics; mirrors the daemon route's status-card shape.
 */
export function NetworkStatusRoute() {
    const { data, isLoading, isError, error } = useQuery({
        queryKey: ["net", "status"],
        queryFn: () => fetchJson<NetStatus>("/api/net/status"),
        refetchInterval: 8000,
    });

    if (isLoading && !data) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center text-[var(--dd-text-muted)]">
                Checking link…
            </div>
        );
    }

    if (isError || !data) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 p-8 text-center">
                <p className="text-base font-semibold" style={{ color: "#f87171" }}>
                    Status unavailable
                </p>
                <p className="text-sm text-[var(--dd-text-muted)]">
                    {error instanceof Error ? error.message : "Could not reach the agent."}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 p-2">
            <NetworkStatusCard status={data} />
        </div>
    );
}
