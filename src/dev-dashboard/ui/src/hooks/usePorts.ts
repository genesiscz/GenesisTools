import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { useQuery } from "@tanstack/react-query";
import { useLive } from "@/hooks/useLive";
import { dashboard } from "@/lib/dashboard-client";

/**
 * Ports list + progressive classify via the unified `/api/live` bus.
 * Initial GET is a fallback until the first live snapshot arrives.
 */
export function usePorts(opts?: { refetchIntervalMs?: number; enableLive?: boolean }) {
    const enableLive = opts?.enableLive !== false;

    useLive(enableLive ? ["ports"] : []);

    return useQuery<PortsResult>({
        queryKey: ["ports"],
        queryFn: () => dashboard.call(ENDPOINTS.ports, {}),
        // Live bus owns refresh when enabled; rare fallback poll if stream is down.
        refetchInterval: enableLive ? false : (opts?.refetchIntervalMs ?? 12_000),
        staleTime: enableLive ? 60_000 : 0,
    });
}

export function expectedKillCommand(port: PortInfo): string {
    return port.command || port.fullCommand?.slice(0, 24) || "unknown";
}
