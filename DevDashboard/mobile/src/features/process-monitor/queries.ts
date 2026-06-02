import type { DashboardClient, ProcessSort, ProcessesRes } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Process Monitor data layer (D32 + per-feature layout). Co-locates `processMonitorKeys` and the
 * `processesQuery` `queryOptions` factory over the injected `DashboardClient`, plus the thin
 * `killProcess` client-caller. Uses the typed `client.processes.*` namespace (added to the contract)
 * rather than the raw escape hatch — parity with `obsidian`/`qa`/`todos`.
 *
 * SORT IN THE KEY (load-bearing): `sort` + `limit` are part of the query key, so flipping the sort
 * drives a real refetch with the new `?sort=` and each mode is cached independently. The server stays
 * authoritative for ordering — the Appium real-state assertion proves the server-applied sort, not a
 * client-side `Array.sort`.
 *
 * Polling: 5 s matches Pulse's cadence (the full list is heavier than top-5 → keep `limit=50`).
 */

export const processMonitorKeys = {
    list: (sort: ProcessSort, limit: number) => ["process-monitor", "list", sort, limit] as const,
} as const;

export const PROCESSES_INTERVAL_MS = 5_000;
export const DEFAULT_LIMIT = 50;

export function processesQuery(client: DashboardClient, sort: ProcessSort, limit = DEFAULT_LIMIT) {
    return queryOptions<ProcessesRes>({
        queryKey: processMonitorKeys.list(sort, limit),
        queryFn: () => client.processes.list(sort, limit),
        refetchInterval: PROCESSES_INTERVAL_MS,
    });
}

export interface KillProcessInput {
    pid: number;
}

export function killProcess(client: DashboardClient, input: KillProcessInput) {
    return client.processes.kill(input.pid);
}
