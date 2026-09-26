import type { TranscriptProvider } from "@genesiscz/utils/ai/transcripts";

// Session insights for the hub's Session Details: per-prompt cost timeline, tool analytics, stuck
// verdicts and the handoff composer. One core (this folder), three doors: `tools hub insights|stuck|
// handoff` on the CLI, and the Swift hub, which runs those commands off its main thread.

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

export interface StuckThresholds {
    /** A pending tool call older than this is stuck. */
    toolMinutes: number;
    /** This many identical tool calls in a row at the end of the transcript is a loop. */
    repeats: number;
    /** A pending call older than this belongs to a session that died, not one that is stuck. */
    maxAgeHours: number;
    /** A loop counts only while its last call is at most this old. */
    activeMinutes: number;
    /** Tools that legitimately run long (sub-agents, monitors). */
    ignoreLongTools: string[];
    /** Tools that legitimately repeat (polling a background shell). */
    ignoreRepeatTools: string[];
}

export type StuckKind = "long-tool" | "repeat-loop";

export interface StuckVerdict {
    kind: StuckKind;
    tool: string;
    /** The call's key argument (a command, a path, a pattern), clipped. */
    argument: string;
    /** One sentence for a badge tooltip or a CLI line. */
    detail: string;
    /** When the pending call started, or when the loop's first call ran. */
    since: string | null;
    elapsedMs: number | null;
    /** Calls in the loop (1 for a long tool). */
    count: number;
    /** Failed calls in the loop. */
    failures: number;
    turnIndex: number;
    toolId: string;
}

export interface SessionStuck {
    sessionId: string;
    provider: TranscriptProvider;
    title: string | null;
    verdict: StuckVerdict | null;
    /** Set when the session's transcript could not be read. */
    error?: string;
}

export interface SessionInsights {
    sessionId: string;
    provider: TranscriptProvider;
    filePath: string;
    title: string | null;
    cwd: string | null;
    branch: string | null;
    turnCount: number;
    /** True when every model call had a price. */
    priced: boolean;
    pricingNote: string;
    totals: TokenTotals;
    turns: TurnCost[];
    tools: ToolStat[];
    stuck: StuckVerdict | null;
    thresholds: StuckThresholds;
    generatedAt: string;
}

export const EXPENSIVE_TURNS = 3;
