import type { RunSummary } from "@app/dev-dashboard/contract/dto";
import { paths } from "@app/dev-dashboard/contract/endpoints";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { LogStream } from "@/components/build-log-tail/LogStream";
import { RunPicker } from "@/components/build-log-tail/RunPicker";
import { fetchJson } from "@/lib/api";

/**
 * Live Build/Run Log Tail (web). Pick a recent daemon run, then live-tail its log over SSE
 * (`GET /api/daemon/runs/tail`) with error highlighting + jump-to-error. The backlog (static
 * `GET /api/daemon/runs/log`) seeds the list; the live tail appends. Web parity with the mobile
 * `(more)/build-log-tail` screen — distinct from the daemon page's STATIC LogModal (this streams).
 */
export function BuildLogTailRoute() {
    const [selected, setSelected] = useState<RunSummary | null>(null);
    const logFile = selected?.logFile ?? null;

    const runsQuery = useQuery({
        queryKey: ["build-log-tail", "runs"],
        queryFn: async (): Promise<RunSummary[]> => {
            const runs = await fetchJson<RunSummary[]>(paths.daemonRuns({ limit: 25 }));
            return Array.isArray(runs) ? runs : [];
        },
        refetchInterval: 15000,
    });

    if (runsQuery.isLoading && !runsQuery.data) {
        return (
            <div
                data-testid="build-log-tail-loading"
                className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center text-[var(--dd-text-muted)]"
            >
                Loading runs…
            </div>
        );
    }

    if (runsQuery.isError) {
        return (
            <div
                data-testid="build-log-tail-error"
                className="dd-panel flex h-[calc(100vh-2rem)] flex-col items-center justify-center gap-2 text-center"
            >
                <p className="text-lg font-bold text-[#f87171]">Runs unavailable</p>
                <p className="max-w-sm text-sm text-[var(--dd-text-secondary)]">
                    {runsQuery.error instanceof Error ? runsQuery.error.message : "Could not reach the agent."}
                </p>
            </div>
        );
    }

    return (
        <div className="flex h-[calc(100vh-2rem)] flex-col gap-4 p-2">
            <RunPicker runs={runsQuery.data ?? []} selectedLogFile={logFile} onSelect={setSelected} />
            <LogStream logFile={logFile} />
        </div>
    );
}
