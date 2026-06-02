export type AgentState = "RUNNING" | "FINISHED" | "STALLED" | "AWAITING-INPUT";

export type WatchSourceName = "task" | "claude" | "workflows";

/** Normalized event, source-agnostic. Adapters convert native records into this. */
export interface AgentEvent {
    /** Epoch ms when the event happened. */
    ts: number;
    kind: "start" | "output" | "exit" | "question";
    /** Exit status when kind === "exit" (process exit code). */
    exitCode?: number;
    /** Human-readable text for the last-line preview (output/question events). */
    text?: string;
}

/** Input to the PURE classifier. Nothing here is read from a clock or fs. */
export interface ClassifyInput {
    /** Ordered oldest→newest. May be empty. */
    events: AgentEvent[];
    /** Epoch ms the underlying file/dir was last modified. */
    lastModified: number;
    /** Injected "current time" in epoch ms. */
    now: number;
    /** Stall threshold in ms. */
    stallTimeoutMs: number;
    /**
     * Tri-state pid liveness hint resolved OUTSIDE the core:
     *   true  → pid confirmed alive
     *   false → pid confirmed dead (forces FINISHED if not awaiting input)
     *   undefined → no pid info; rely on events + timing only
     */
    pidAlive?: boolean;
}

/** One discovered agent after classification. */
export interface AgentSnapshot {
    /** Stable unique id, e.g. "task:checks-6984". */
    id: string;
    name: string;
    source: WatchSourceName;
    state: AgentState;
    /** Epoch ms of the newest event (or file mtime if no events). */
    lastOutputAt: number;
    /** now - lastOutputAt, ms. */
    ageMs: number;
    exitCode?: number;
    lastLine?: string;
}

/** Injectable notification sink. Production wraps dispatchNotification; tests stub it. */
export interface Notifier {
    notify(input: { title: string; message: string; subtitle?: string }): Promise<void>;
}

export interface CollectOptions {
    sources: WatchSourceName[];
    now: number;
    stallTimeoutMs: number;
    /** Optional root overrides — injected by tests for hermeticity. Defaults to homedir-derived paths. */
    roots?: { task?: string; claude?: string; workflow?: string };
}
