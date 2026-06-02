import type { ProcessInfo, ProcessSort } from "@app/dev-dashboard/lib/system/types";
import type { ProcessesRes } from "@app/dev-dashboard/contract/endpoints";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ProcessesTable } from "@/components/process-monitor/ProcessesTable";
import { processesApi } from "@/lib/api";

export function ProcessMonitorRoute() {
    const [sort, setSort] = useState<ProcessSort>("rss");
    const queryClient = useQueryClient();

    const { data } = useQuery<ProcessesRes>({
        queryKey: ["processes", sort],
        queryFn: () => processesApi.list(sort),
        refetchInterval: 5000,
    });

    const killMutation = useMutation({
        mutationFn: (pid: number) => processesApi.kill(pid),
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: ["processes"] });
        },
    });

    const handleKill = (process: ProcessInfo) => {
        if (window.confirm(`Kill ${process.name} (pid ${process.pid})?`)) {
            killMutation.mutate(process.pid);
        }
    };

    return (
        <div className="h-[calc(100vh-2rem)]">
            {data ? (
                <ProcessesTable
                    processes={data.processes}
                    sort={sort}
                    onSortChange={setSort}
                    onKill={handleKill}
                    killingPid={killMutation.isPending ? killMutation.variables : null}
                />
            ) : (
                <div className="dd-panel flex h-full items-center justify-center text-[var(--dd-text-muted)]">
                    Loading processes...
                </div>
            )}
        </div>
    );
}
