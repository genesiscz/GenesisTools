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
    exitCode?: number;
    durationMs?: number;
    exitedAt?: string;
}

export interface TaskConfig {
    recentSession?: string;
}

export type LogOutputFormat = "human" | "raw" | "jsonl";

export interface LogQueryOpts {
    session: string;
    lines?: number;
    fromSeq?: number;
    toSeq?: number;
    grep?: string;
    format: LogOutputFormat;
    streams: Set<"stdout" | "stderr">;
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
