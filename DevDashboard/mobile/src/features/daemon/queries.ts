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
 * Shape guard: the fixture wire (`src/api/fixture-wire.ts`) answers each daemon path with its own
 * fixture. The `asArray` guard still coerces an empty `{}` to `[]`, so an older Mac agent renders an
 * empty runs list instead of crashing on `.map`.
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

/**
 * Coerce an escape-hatch payload to an array. The mock's gap is specifically an EMPTY object, so only
 * that shape is absorbed — any other non-array is a real malformed response and throws rather than
 * being silently rendered as an empty list.
 */
function asArray<T>(value: unknown, source: string): T[] {
    if (Array.isArray(value)) {
        return value as T[];
    }

    if (value && typeof value === "object" && Object.keys(value).length === 0) {
        return [];
    }

    throw new TypeError(`${source} returned a non-array payload`);
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
        queryFn: async () =>
            asArray<RunSummary>(await client.get<RunSummary[]>(paths.daemonRuns({ limit })), "daemon runs"),
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

            return asArray<LogEntry>(await client.get<LogEntry[]>(paths.daemonRunLog(logFile)), "daemon run log");
        },
        enabled: Boolean(logFile),
    });
}
