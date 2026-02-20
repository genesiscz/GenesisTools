export type LogLevel =
    | "dump"
    | "info"
    | "warn"
    | "error"
    | "timer-start"
    | "timer-end"
    | "checkpoint"
    | "assert"
    | "snapshot"
    | "trace"
    | "raw";

export interface LogEntry {
    level: LogLevel;
    label?: string;
    msg?: string;
    data?: unknown;
    vars?: Record<string, unknown>;
    stack?: string;
    passed?: boolean;
    ctx?: unknown;
    durationMs?: number;
    ts: number;
    file?: string;
    line?: number;
    /** Hypothesis tag */
    h?: string;
}

export interface IndexedLogEntry extends LogEntry {
    index: number;
    refId?: string;
}

export interface TimerPair {
    label: string;
    startTs: number;
    endTs: number;
    durationMs: number;
    startIndex: number;
    endIndex: number;
}

export interface SessionStats {
    entryCount: number;
    levelCounts: Record<string, number>;
    timerPairs: TimerPair[];
    avgTimerMs: number;
    assertsPassed: number;
    assertsFailed: number;
    startTime: number;
    endTime: number;
    spanMs: number;
    files: string[];
}

export interface ProjectConfig {
    snippetPath: string;
    language: "typescript" | "php";
}

export interface DebugMasterConfig {
    projects: Record<string, ProjectConfig>;
    recentSession?: string;
}

export interface SessionMeta {
    name: string;
    projectPath: string;
    createdAt: number;
    lastActivityAt: number;
    serve?: boolean;
    port?: number;
}

export type OutputFormat = "ai" | "json" | "md";

export interface GlobalOptions {
    session?: string;
    format: OutputFormat;
    pretty?: boolean;
    verbose?: boolean;
}
