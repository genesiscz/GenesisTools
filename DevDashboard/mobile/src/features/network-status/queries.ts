import type { DashboardClient, NetStatusRes } from "@dd/contract";
import { paths } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * network-status feature data layer (D32 + per-feature layout). Co-locates `netStatusKeys` and the
 * `queryOptions` factory over the injected `DashboardClient`. Mirrors features/daemon/queries.ts.
 *
 * ESCAPE-HATCH NOTE: the contract has no typed `client.net.*` namespace; we use the generic
 * `client.get<NetStatusRes>(paths.netStatus())` (same as the daemon/containers deferred features).
 *
 * Polling: 8 s — the link health changes when you switch network / VPN, and a fresh self-ping each
 * tick keeps the latency value live without hammering.
 */

export const netStatusKeys = {
    status: ["net", "status"] as const,
} as const;

export const NET_STATUS_INTERVAL_MS = 8_000;

export function netStatusQuery(client: DashboardClient) {
    return queryOptions<NetStatusRes>({
        queryKey: netStatusKeys.status,
        queryFn: () => client.get<NetStatusRes>(paths.netStatus()),
        refetchInterval: NET_STATUS_INTERVAL_MS,
    });
}
