import type { DashboardClient, LogEntry, RunSummary } from "@dd/contract";
import { paths } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Build-log-tail data layer (D32). REUSES the existing daemon endpoints — the run picker reads
 * `GET /api/daemon/runs` (same as the daemon screen) and the pre-tail backlog reads
 * `GET /api/daemon/runs/log` (the static log). The LIVE tail is NOT a query — it's the SSE
 * subscription in subscription.ts. Mirrors daemon/queries.ts incl. the `asArray` escape-hatch guard.
 */

export const buildLogKeys = {
    runs: (limit: number) => ["build-log-tail", "runs", limit] as const,
    backlog: (logFile: string) => ["build-log-tail", "backlog", logFile] as const,
} as const;

export const RUNS_INTERVAL_MS = 15_000;
export const RUNS_LIMIT = 25;
export const BACKLOG_LIMIT = 500;

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

export function buildLogRunsQuery(client: DashboardClient, limit: number = RUNS_LIMIT) {
    return queryOptions<RunSummary[]>({
        queryKey: buildLogKeys.runs(limit),
        queryFn: async () => asArray<RunSummary>(await client.get<RunSummary[]>(paths.daemonRuns({ limit }))),
        refetchInterval: RUNS_INTERVAL_MS,
    });
}

export function buildLogBacklogQuery(client: DashboardClient, logFile: string | null) {
    return queryOptions<LogEntry[]>({
        queryKey: buildLogKeys.backlog(logFile ?? ""),
        queryFn: async () => {
            if (!logFile) {
                return [];
            }

            const all = asArray<LogEntry>(await client.get<LogEntry[]>(paths.daemonRunLog(logFile)));
            // Only seed the tail UI with the last BACKLOG_LIMIT lines so a giant finished log doesn't
            // blow the FlatList; the live tail appends from there.
            return all.slice(-BACKLOG_LIMIT);
        },
        enabled: logFile != null,
    });
}
