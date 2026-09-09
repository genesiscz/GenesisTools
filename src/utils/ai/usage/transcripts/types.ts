import type { CodexContext } from "./codex-context";

export interface DriverUsageEvent {
    /**
     * Dedup key, unique within one transcript. Agents that stamp a message or
     * event id use it verbatim; the rest synthesize one from the fields that
     * make a request unique (timestamp, model, token counts).
     */
    id: string;
    model: string;
    /** ISO-8601 timestamp. "" when the line carried none (the event is dropped). */
    timestamp: string;
    /** Billable, NON-cached input tokens (cache reads/writes are separate below). */
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    /** Subset of outputTokens. Codex/Grok report it; never added on top of output. */
    reasoningOutputTokens?: number;
    /**
     * Cost in USD that the agent itself recorded for this event. Authoritative
     * when present: Grok prices each API request separately and only reports
     * the per-turn sum, so recomputing from the summed tokens cannot land on
     * the same figure. Absent means "derive it from the catalog rates".
     */
    recordedCostUsd?: number;
    serviceTier?: string;
    codex?: CodexContext;
}

/**
 * A parser bound to ONE transcript. Codex carries state across lines (the
 * sticky `turn_context` model, the previous cumulative totals), and the
 * incremental cache resumes a file mid-way, so that state has to survive
 * between runs — hence `snapshot()`, which is persisted next to the file's
 * byte offset and handed back on the next run.
 */
export interface DriverLineParser {
    /**
     * Emit every usage event on this line. One line can bill several models
     * (Grok's per-turn `modelUsage` map), and most lines bill none, so events
     * are pushed rather than returned — no array is allocated for the common
     * case of a line that carries no usage at all.
     */
    parseLine(line: string, emit: (event: DriverUsageEvent) => void): void;
    /** JSON-serializable resume state, or undefined for stateless drivers. */
    snapshot(): unknown;
}

export interface CreateParserOptions {
    /** Absolute path of the transcript being parsed (siblings, session ids). */
    file: string;
    /** Whatever `snapshot()` returned last run, or undefined on a fresh parse. */
    state: unknown;
}
