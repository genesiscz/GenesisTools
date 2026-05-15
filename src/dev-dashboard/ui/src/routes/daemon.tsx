import type { DaemonOverview, RunSummary } from "@app/dev-dashboard/lib/daemon-view/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DaemonHeader } from "@/components/daemon/DaemonHeader";
import { LogModal } from "@/components/daemon/LogModal";
import { RunsTimeline } from "@/components/daemon/RunsTimeline";
import { TasksTable } from "@/components/daemon/TasksTable";

export function DaemonRoute() {
    const [selectedLogFile, setSelectedLogFile] = useState<string | null>(null);

    const { data: overview, isLoading } = useQuery({
        queryKey: ["daemon", "status"],
        queryFn: (): Promise<DaemonOverview> => fetch("/api/daemon/status").then((r) => r.json()),
        refetchInterval: 5000,
    });

    const { data: runs } = useQuery({
        queryKey: ["daemon", "runs"],
        queryFn: (): Promise<RunSummary[]> => fetch("/api/daemon/runs?limit=20").then((r) => r.json()),
        refetchInterval: 5000,
    });

    if (isLoading && !overview) {
        return (
            <div className="dd-panel flex h-[calc(100vh-2rem)] items-center justify-center text-[var(--dd-text-muted)]">
                Loading daemon status…
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 p-2">
            <DaemonHeader status={overview?.status ?? { installed: false, running: false, pid: null }} />
            <TasksTable tasks={overview?.tasks ?? []} />
            <RunsTimeline runs={runs ?? []} onSelect={setSelectedLogFile} />
            <LogModal logFile={selectedLogFile} onClose={() => setSelectedLogFile(null)} />
        </div>
    );
}
