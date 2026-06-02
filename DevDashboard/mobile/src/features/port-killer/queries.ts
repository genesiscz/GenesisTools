import type { DashboardClient, KillPortResult, PortsRes } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Port-killer feature data layer (D32 + per-feature layout). Read uses the typed `client.ports.list()`
 * namespace; the confirm-gated kill goes through `client.ports.kill()`. Mirrors
 * features/containers/queries.ts (read) and features/terminals/queries.ts (mutation factory).
 *
 * Polling: 8 s — ports flip when a dev server starts/stops, not continuously.
 */

export const portKillerKeys = {
    list: ["ports", "list"] as const,
} as const;

export const PORTS_INTERVAL_MS = 8_000;

export function portsQuery(client: DashboardClient) {
    return queryOptions<PortsRes>({
        queryKey: portKillerKeys.list,
        queryFn: () => client.ports.list(),
        refetchInterval: PORTS_INTERVAL_MS,
    });
}

export interface KillPortInput {
    pid: number;
    expectedCommand?: string;
}

export function killPort(client: DashboardClient, input: KillPortInput): Promise<KillPortResult> {
    return client.ports.kill(input.pid, input.expectedCommand);
}
