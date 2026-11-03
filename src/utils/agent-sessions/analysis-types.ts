/**
 * The facts a session analysis reads from one transcript (design 2026-11-01, proposal 2): every model call, every
 * compaction, and the quota readings a transcript carries. Each is a REQUIRED member of `NativeSessionReader.analysis`,
 * implemented by Claude, Codex and Grok (`.claude/rules/agent-transcripts.md`). A provider whose files do not hold a
 * fact answers `{ supported: false, reason }`, never an empty list, so a caller can tell "none happened" from "this
 * harness does not record it".
 */
export type SessionFacts<T> = { supported: true; items: T[] } | { supported: false; reason: string };

/** One model call, its tokens split the way every price is: uncached input, cache read, cache write, output. */
export interface SessionCall {
    /** Dedup key inside the transcript: the message or response id, or a synthesized one. */
    id: string;
    /** ISO instant in UTC. */
    t: string;
    model: string;
    /** Billable input that was neither read from nor written to the cache. */
    input: number;
    cacheRead: number;
    cacheWrite: number;
    /** The one-hour share of `cacheWrite` (Claude); absent when the harness does not split it. */
    cacheWrite1h?: number;
    output: number;
    /** A call a sub-agent made inside the lead's transcript (Claude sidechains). */
    sidechain: boolean;
    /** The row sums several requests (a Grok turn), so no single request's prompt size is known. */
    aggregate: boolean;
    /** Cost the harness itself recorded for the call, when it records one. */
    recordedCostUsd?: number;
    /** The service tier the call ran at (Codex `priority`/`flex`), which its price depends on; absent when unknown. */
    serviceTier?: string;
}

/** A point where the harness replaced the conversation by a summary. */
export interface SessionCompaction {
    /** ISO instant in UTC. */
    t: string;
    /** `auto`, `manual` or the harness's own word; null when the row names none. */
    trigger: string | null;
    /** Context size just before the compaction, when the row states it. */
    preTokens: number | null;
}

/** One reading of a provider quota window that the harness wrote into the transcript (Codex `rate_limits`). */
export interface SessionQuotaReading {
    /** ISO instant in UTC. */
    t: string;
    /** The harness's own slot name (`primary`, `secondary`). */
    slot: string;
    usedPercent: number;
    windowMinutes: number | null;
    /** ISO instant in UTC, or null when the row names no reset. */
    resetsAt: string | null;
}

/** The analysis facts of one transcript. Each member reads the file it is given and never writes. */
export interface SessionAnalysisReader {
    /** Every model call, oldest first, each once (a repeated message id keeps its first row). */
    callTrace(transcriptPath: string): Promise<SessionFacts<SessionCall>>;
    /** Every compaction, oldest first. */
    compactions(transcriptPath: string): Promise<SessionFacts<SessionCompaction>>;
    /** Quota readings the transcript itself carries, oldest first. */
    quotaReadings(transcriptPath: string): Promise<SessionFacts<SessionQuotaReading>>;
}

/** The items of an answer, or an empty list when the harness cannot answer. */
export function factsOf<T>(facts: SessionFacts<T>): T[] {
    return facts.supported ? facts.items : [];
}
