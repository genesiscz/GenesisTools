// Per-call and per-turn cost shapes a transcript's insights are built from: what the native session
// file adds to the transcript turns (`native-scan.ts`) and the per-prompt cost timeline and tool
// analytics built on them (`turn-cost.ts`). The hub's Session Details reads them through
// `tools hub insights`.

/** One model call's tokens, as the provider recorded them. `input` never includes cache tokens. */
export interface CallTokens {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
}

/** One model call found in the native session file (Claude), in file order. */
export interface NativeCall extends CallTokens {
    /** Line number (1-based, counting only conversation lines) the call first appeared on. */
    ordinal: number;
    messageId: string;
    model: string | null;
    at: string | null;
}

/** When a tool call started and when its result arrived, from the native file's timestamps. */
export interface ToolTiming {
    startedAt: string | null;
    endedAt: string | null;
}

/** What the Claude session file adds to the transcript turns: per-call usage, models, exact tool timing. */
export interface NativeScan {
    /** Turn id (line uuid) → ordinal, for every conversation line. */
    ordinals: Map<string, number>;
    calls: NativeCall[];
    toolTimings: Map<string, ToolTiming>;
    /** The last `cwd` / `gitBranch` a line recorded. */
    cwd: string | null;
    branch: string | null;
}

export interface TokenTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    modelCalls: number;
    /** List-price estimate; null when any call in the range had no price. */
    costUsd: number | null;
}

/** One bar of the timeline: a user prompt and the agent's work until the next prompt. */
export interface TurnCost extends TokenTotals {
    /** The transcript's "Prompt #N": the prompt's 1-based turn index. 0 for work before the first prompt. */
    number: number;
    /** 0-based turn index of the prompt (of the first turn for the lead section). */
    index: number;
    /** Turn id of the prompt, which the hub's transcript row ids are built from (`p-<id>`). */
    turnId: string;
    /** The prompt's first line, clipped. */
    label: string;
    at: string | null;
    durationMs: number | null;
    models: string[];
    toolCount: number;
    errorCount: number;
    /** 1 = the most expensive turn of the session, up to `EXPENSIVE_TURNS`; null otherwise. */
    rank: number | null;
}

export interface ToolStat {
    name: string;
    count: number;
    failures: number;
    /** failures / count, 0..1. */
    failureRate: number;
    /** Sum of the known durations, ms. */
    totalMs: number;
    slowestMs: number | null;
    slowestToolId: string | null;
    /** 0-based turn index of the slowest call. */
    slowestTurnIndex: number | null;
    /** `exact`: from the native file's result timestamps. `upper-bound`: gap to the next transcript entry. */
    timing: "exact" | "upper-bound";
}

export const EXPENSIVE_TURNS = 3;
