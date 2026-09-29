import type { TranscriptProvider } from "@genesiscz/utils/ai/transcripts";
import type { TokenTotals, ToolStat, TurnCost } from "@genesiscz/utils/ai/transcripts/insights-types";

// Session insights for the hub's Session Details: per-prompt cost timeline, tool analytics, stuck
// verdicts and the handoff composer. One core (this folder), three doors: `tools hub insights|stuck|
// handoff` on the CLI, and the Swift hub, which runs those commands off its main thread.

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
    /**
     * Discovery only: whether a live agent process holds the session (`tools hub procs`); a transcript
     * without one is an exited agent that left no end record. Null when the process table could not be
     * read; absent for sessions named explicitly (the hub names only its live ones).
     */
    running?: boolean | null;
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
