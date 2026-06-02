import type { DashboardClient, DiskUsageResult } from "@dd/contract";
import { paths } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Disk Janitor data layer (D32 + per-feature layout). Mirrors features/containers/queries.ts: the
 * contract has no typed `client.disk.*` namespace, so we use the generic `client.get<T>(path)`
 * escape hatch with `paths.diskUsage()`. The mock returns a real `DiskUsageResult` for that path.
 *
 * Polling: 60 s — `du` is expensive and disk usage drifts slowly; a long interval avoids hammering
 * the host with recursive scans.
 */

export const diskJanitorKeys = {
    usage: ["disk-janitor", "usage"] as const,
} as const;

export const DISK_JANITOR_INTERVAL_MS = 60_000;

const EMPTY_RESULT: DiskUsageResult = { available: false, scannedAt: "", entries: [] };

/** Coerce an escape-hatch payload to a well-formed DiskUsageResult (defensive vs. an unknown route). */
function asDiskUsageResult(value: unknown): DiskUsageResult {
    if (value && typeof value === "object" && Array.isArray((value as { entries?: unknown }).entries)) {
        return value as DiskUsageResult;
    }

    return EMPTY_RESULT;
}

export function diskUsageQuery(client: DashboardClient) {
    return queryOptions<DiskUsageResult>({
        queryKey: diskJanitorKeys.usage,
        queryFn: async () => asDiskUsageResult(await client.get<DiskUsageResult>(paths.diskUsage())),
        refetchInterval: DISK_JANITOR_INTERVAL_MS,
    });
}
