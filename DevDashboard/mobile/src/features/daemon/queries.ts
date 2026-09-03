import type { DaemonOverview, DashboardClient, LogEntry, RunSummary } from "@dd/contract";
import { paths } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/**
 * Daemon feature data layer (D32 + per-feature layout). Co-locates `daemonKeys` and the
 * `queryOptions` factories over the injected `DashboardClient`. Mirrors src/features/pulse/queries.ts.
 *
 * ESCAPE-HATCH NOTE: the contract has no typed `client.daemon.*` namespace yet — the deferred
 * features use generic `client.get<T>(path)` (the contract says so). We supply `T` explicitly
 * (`DaemonOverview`, `RunSummary[]`, `LogEntry[]`) and build paths via `paths.*`.
 *
 * MOCK GAPS (flagged, NOT fixed — mock-client.ts is shared/read-only):
 *  - `/api/daemon/status` → the mock returns a real `DaemonOverview` (running, no tasks).
 *  - `/api/daemon/runs` and `/api/daemon/runs/log` do NOT prefix-match `/api/daemon/status`, so the
 *    mock falls through to `{}` (an empty object, NOT `[]`). The `asArray` guard coerces those to
 *    `[]` so the runs list + log viewer render empty instead of crashing on `.map`. A real device
 *    returns true arrays. See 20-impl-09-rest-notes.md.
 *
 * Polling: 10 s status (it changes on install/start/stop), 15 s runs (new runs append), runs-log is
 * fetched on demand (no interval — the log of a finished run is static).
 */

export const daemonKeys = {
    status: ["daemon", "status"] as const,
    runs: (limit: number) => ["daemon", "runs", limit] as const,
    runLog: (logFile: string) => ["daemon", "run-log", logFile] as const,
} as const;

export const STATUS_INTERVAL_MS = 10_000;
export const RUNS_INTERVAL_MS = 15_000;
export const DEFAULT_RUNS_LIMIT = 25;

/** Coerce an escape-hatch payload to an array (mock returns `{}` for the unmocked routes). */
function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

export function daemonStatusQuery(client: DashboardClient) {
    return queryOptions<DaemonOverview>({
        queryKey: daemonKeys.status,
        queryFn: () => client.get<DaemonOverview>(paths.daemonStatus()),
        refetchInterval: STATUS_INTERVAL_MS,
    });
}

export function daemonRunsQuery(client: DashboardClient, limit: number = DEFAULT_RUNS_LIMIT) {
    return queryOptions<RunSummary[]>({
        queryKey: daemonKeys.runs(limit),
        queryFn: async () => asArray<RunSummary>(await client.get<RunSummary[]>(paths.daemonRuns({ limit }))),
        refetchInterval: RUNS_INTERVAL_MS,
    });
}

export function daemonRunLogQuery(client: DashboardClient, logFile: string | null) {
    return queryOptions<LogEntry[]>({
        queryKey: daemonKeys.runLog(logFile ?? ""),
        queryFn: async () => {
            if (!logFile) {
                return [];
            }

            return asArray<LogEntry>(await client.get<LogEntry[]>(paths.daemonRunLog(logFile)));
        },
        enabled: logFile != null,
    });
}
