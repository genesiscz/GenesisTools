export interface RunLogRetention {
    /** Delete run logs older than this many days … */
    maxAgeDays: number;
    /** …but only when more than this many run logs exist, and never
     *  delete one of the newest `minRuns`. Both conditions must hold. */
    minRuns: number;
}

export interface DaemonTask {
    name: string;
    command: string;
    every: string;
    retries: number;
    enabled: boolean;
    description?: string;
    /** Send macOS notifications on start/complete/fail. Default: true */
    notify?: boolean;
    /** Optional run-log retention; the daemon prunes post-run. Absent = keep all. */
    retention?: RunLogRetention;
}

export interface DaemonConfig {
    tasks: DaemonTask[];
}

export interface LogMeta {
    type: "meta";
    taskName: string;
    command: string;
    runId: string;
    attempt: number;
    startedAt: string;
}

export interface LogLine {
    type: "stdout" | "stderr";
    ts: string;
    data: string;
}

export interface LogExit {
    type: "exit";
    ts: string;
    code: number | null;
    duration_ms: number;
}

export type LogEntry = LogMeta | LogLine | LogExit;

export interface TaskState {
    nextRunAt: Date;
    attemptCount: number;
    running: boolean;
}

export interface RunResult {
    exitCode: number | null;
    duration_ms: number;
    logFile: string;
}

export interface RunSummary {
    taskName: string;
    runId: string;
    logFile: string;
    startedAt: string;
    exitCode: number | null;
    duration_ms: number | null;
    attempt: number;
}
