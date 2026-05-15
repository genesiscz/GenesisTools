import type { DaemonTask, RunSummary, LogEntry } from "@app/daemon/lib/types";

export interface DaemonOverview {
    status: { installed: boolean; running: boolean; pid: number | null };
    tasks: DaemonTask[];
}

export type { DaemonTask, RunSummary, LogEntry };
