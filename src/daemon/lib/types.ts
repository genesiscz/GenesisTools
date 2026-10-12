export interface RunLogRetention {
    /** Delete run logs older than this many days … */
    maxAgeDays: number;
    /** …but only when more than this many run logs exist, and never
     *  delete one of the newest `minRuns`. Both conditions must hold. */
    minRuns: number;
}

/** How a task's child process is scheduled by macOS. The daemon itself is a launchd `ProcessType=Background` job,
 *  so without a priority every child inherits background QoS (throttled CPU and disk). */
export const TASK_PRIORITIES = ["high", "normal", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** What happens when a time-of-day run was missed (the Mac was asleep, or the daemon was not running):
 *  - `asap`: run at the first scheduler tick, even in a DarkWake (the behaviour before policies existed; default).
 *  - `on-wake`: run at the first full wake (the display is on, not a DarkWake), at low priority.
 *  - `retry-at`: run at the first of `times` (HH:MM, local) still ahead that day; a failed run tries the next one.
 *  - `skip`: wait for the next regular time. */
export const MISSED_RUN_MODES = ["asap", "on-wake", "retry-at", "skip"] as const;
export type MissedRunMode = (typeof MISSED_RUN_MODES)[number];

export interface MissedRunPolicy {
    mode: MissedRunMode;
    /** `retry-at` only: local HH:MM times, in the order they are tried. */
    times?: string[];
}

/** Why a run happened, recorded in its run log. */
/** Why a run started: its slot came, a missed slot is caught up, a retry-at retry, or `tools daemon run` by hand. */
export type RunReason = "scheduled" | "catch-up" | "retry" | "manual";

export interface DaemonTask {
    name: string;
    command: string;
    every: string;
    retries: number;
    enabled: boolean;
    description?: string;
    /** Kill a task that has not exited after this many milliseconds. Default: 10 minutes. */
    timeoutMs?: number;
    /** Send macOS notifications on start/complete/fail. Default: true. `"failure"`: only when it fails. */
    notify?: boolean | "failure";
    /** Optional run-log retention; the daemon prunes post-run. Absent = keep all. */
    retention?: RunLogRetention;
    /** Child QoS and start order among tasks due together. Default: normal (inherits the daemon's QoS). */
    priority?: TaskPriority;
    /** Time-of-day tasks only: what to do when a run was missed. Default: `{ mode: "asap" }`. */
    missedRun?: MissedRunPolicy;
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
    /** Why the run happened. Absent in logs written before reasons existed. */
    reason?: RunReason;
    priority?: TaskPriority;
    /** The regular time-of-day slot a catch-up or retry stands in for (ISO). */
    scheduledFor?: string;
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
    timedOut?: boolean;
}

export type LogEntry = LogMeta | LogLine | LogExit;

export interface TaskState {
    nextRunAt: Date;
    attemptCount: number;
    running: boolean;
    /**
     * Runs that failed one after another, and when the last banner for the streak went up. It lives
     * in memory only: a daemon restart, or a task removed and added back, starts a new streak, so a
     * task that is still failing then puts up one more first banner.
     */
    failureStreak?: { count: number; notifiedAt: number };
    /** Why the run at `nextRunAt` happens. Absent means "scheduled". */
    reason?: RunReason;
    /** Time-of-day tasks: the regular slot the pending run belongs to. */
    slotAt?: Date;
    /** `retry-at` tasks: retry times (epoch ms) still open for this slot. */
    retryQueue?: number[];
}

/** One run as the scheduler starts it. */
export interface RunContext {
    reason: RunReason;
    priority: TaskPriority;
    /** The regular slot a catch-up or retry stands in for. */
    scheduledFor?: Date;
}

export interface RunResult {
    exitCode: number | null;
    duration_ms: number;
    logFile: string;
    /** The run's id, the last part of its log file name (`tools daemon stats --view run --run <id>`). */
    runId: string;
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
