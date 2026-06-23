import type { DaemonTask, LogEntry, RunSummary } from "@app/daemon/lib/types";

export interface DaemonOverview {
    status: { installed: boolean; running: boolean; pid: number | null };
    tasks: DaemonTask[];
}

export type { DaemonTask, LogEntry, RunSummary };
