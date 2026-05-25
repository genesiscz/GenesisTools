export type TaskRunMode = "pty" | "pipe";

export type TaskSessionState = "active" | "exited" | "unknown";

export interface TaskSessionMeta {
    name: string;
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

export interface RunTaskOptions {
    session: string;
    command: string[];
    mode: TaskRunMode;
    cwd?: string;
}

export interface RunTaskResult {
    exitCode: number;
    durationMs: number;
    session: string;
}
