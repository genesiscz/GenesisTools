export type TaskRunMode = "pty" | "pipe";

export type TaskSessionState = "active" | "exited" | "unknown";

export type SessionReuseMode = "reuse-clear" | "reuse-continue" | "prefix";

export interface ResolvedRunSession {
    session: string;
    requested: string;
    renamed: boolean;
    reuse?: SessionReuseMode;
    previousLastSeq?: number;
}

export interface TaskSessionMeta {
    name: string;
    requestedAs?: string;
    command: string;
    mode: TaskRunMode;
    cwd: string;
    createdAt: number;
    lastActivityAt: number;
    startedAt: string;
    pid?: number;
    /** Command line of `pid` captured when it was recorded — detects pid reuse. */
    pidCommand?: string;
    /**
     * When `pid` started (epoch ms), captured alongside `pidCommand`.
     *
     * A wrapped command's own command line can legitimately change after start
     * (a shell's `-c <simple command>` execs in place, a CLI retitles itself),
     * which `pidCommand` alone cannot tell apart from the pid being recycled
     * onto an unrelated process. The start time can: it survives exec() and a
     * retitle, so a match here rescues a `pidCommand` mismatch instead of the
     * session being wrongly marked exited under the still-running process.
     */
    pidStartedAt?: number;
    exitCode?: number;
    durationMs?: number;
    exitedAt?: string;
    /** Deliberately stopped via `tools task stop` — distinct from a process exit so the UI never reports a signal's exit code (130/143) as if the child chose it. */
    stopped?: boolean;
    stoppedAt?: string;
}

export interface TaskConfig {
    recentSession?: string;
}

export type LogOutputFormat = "human" | "raw" | "jsonl";

export interface LogQueryOpts {
    session: string;
    head?: number;
    tail?: number;
    all?: boolean;
    fromSeq?: number;
    toSeq?: number;
    grep?: string;
    format: LogOutputFormat;
    streams: Set<"stdout" | "stderr">;
}

export interface LogCliOpts {
    session?: string;
    head?: string;
    tail?: string;
    all?: boolean;
    fromSeq?: string;
    toSeq?: string;
    grep?: string;
    jsonl?: boolean;
    raw?: boolean;
    stdout?: boolean;
    stderr?: boolean;
    follow?: boolean;
}

export interface PrepareSessionInput {
    name: string;
    command: string;
    mode: TaskRunMode;
    cwd: string;
    requestedAs?: string;
}

export interface MarkExitedInput {
    name: string;
    exitCode: number;
    durationMs: number;
}

export interface MarkStoppedInput {
    name: string;
    durationMs: number;
}

export interface RunBannerInput {
    session: string;
    command: string[];
    mode: TaskRunMode;
}

export interface RunExitSummaryInput {
    session: string;
    exitCode: number;
    durationMs: number;
}

export interface RunTaskOptions {
    session: string;
    resolved?: ResolvedRunSession;
    command: string[];
    mode: TaskRunMode;
    cwd?: string;
}

export interface RunTaskResult {
    exitCode: number;
    durationMs: number;
    session: string;
    requestedSession: string;
    renamed: boolean;
}
