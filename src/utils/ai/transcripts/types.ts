export type TranscriptProvider = "claude" | "grok" | "codex";

export type TranscriptRole = "user" | "assistant" | "system";

export interface TranscriptTool {
    id: string;
    name: string;
    /** Short preview (path, command, pattern). Not the full args blob. */
    inputPreview: string;
    result: string | null;
    isError: boolean;
    /** Process exit status when the tool ran a command. */
    exitCode?: number;
    /** Length of the full output before `clipResult`, so a reader knows what was cut. */
    resultChars?: number;
}

/** Tokens of the one model call that produced a turn. */
export interface TranscriptUsage {
    inputTokens?: number;
    cacheReadTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
}

/** A terminal event of the transcript, carried by a `system` turn. */
export type TranscriptEvent =
    | { kind: "end"; stopReason: string; costUsd?: number }
    | { kind: "error"; message: string }
    | { kind: "turn.started"; turn: number };

export interface TranscriptTurn {
    id: string;
    role: TranscriptRole;
    at: string | null;
    text: string;
    tools: TranscriptTool[];
    /** Coalesced thinking of this model call. */
    reasoning?: string;
    usage?: TranscriptUsage;
    /** Only on `system` turns that carry a terminal event. */
    event?: TranscriptEvent;
    /** 1-based model-call index inside one worker turn file. */
    step?: number;
}

export interface TranscriptTotals extends TranscriptUsage {
    modelCalls: number;
    costUsd?: number;
}

export interface TranscriptEnvelope {
    provider: TranscriptProvider;
    sessionId: string;
    filePath: string;
    byteSize: number;
    truncated: boolean;
    nextOffset: number;
    turns: TranscriptTurn[];
    /** Summed over EVERY turn of the transcript, not only the slice returned. */
    totals?: TranscriptTotals;
    /** How the transcript ended, from its last terminal event; null while it is still running. */
    terminated?: "end" | "error" | null;
}

export function totalsOf(turns: readonly TranscriptTurn[]): TranscriptTotals {
    const totals: TranscriptTotals = { modelCalls: 0 };
    const add = (key: keyof TranscriptUsage, value: number | undefined) => {
        if (value !== undefined) {
            totals[key] = (totals[key] ?? 0) + value;
        }
    };

    for (const turn of turns) {
        if (turn.usage) {
            totals.modelCalls += 1;
            add("inputTokens", turn.usage.inputTokens);
            add("cacheReadTokens", turn.usage.cacheReadTokens);
            add("outputTokens", turn.usage.outputTokens);
            add("reasoningTokens", turn.usage.reasoningTokens);
        }

        if (turn.event?.kind === "end" && turn.event.costUsd !== undefined) {
            totals.costUsd = (totals.costUsd ?? 0) + turn.event.costUsd;
        }
    }

    return totals;
}

export function terminatedOf(turns: readonly TranscriptTurn[]): "end" | "error" | null {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        const event = turns[i]?.event;
        if (event?.kind === "end" || event?.kind === "error") {
            return event.kind;
        }
    }

    return null;
}

export interface SliceOptions {
    offset?: number;
    limit?: number;
}

export const DEFAULT_TURN_LIMIT = 80;
export const DEFAULT_RESULT_CHARS = 2000;

export function sliceTurns(
    turns: TranscriptTurn[],
    opts: SliceOptions = {}
): { turns: TranscriptTurn[]; truncated: boolean; nextOffset: number; offset: number } {
    const limit = opts.limit ?? DEFAULT_TURN_LIMIT;
    const offset = opts.offset ?? Math.max(0, turns.length - limit);
    const sliced = turns.slice(offset, offset + limit);
    const nextOffset = offset + sliced.length;
    return {
        turns: sliced,
        truncated: nextOffset < turns.length || offset > 0,
        nextOffset,
        offset,
    };
}

export function clipResult(text: string, max = DEFAULT_RESULT_CHARS): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max - 1)}…`;
}

/** The widest epoch a JS Date accepts; beyond it `toISOString()` throws RangeError. */
export const MAX_EPOCH_MS = 8.64e15;

/**
 * ISO-8601 for a transcript record's clock, or null when it is unusable. An
 * unguarded `toISOString()` on a corrupt number throws out of the converter and
 * abandons every remaining line of the file (PR #341 review round 4, t1).
 */
export function isoFromRecordTimestamp(timestamp: unknown): string | null {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        return null;
    }

    const ms = timestamp * (timestamp < 1e12 ? 1000 : 1);
    if (ms <= 0 || ms > MAX_EPOCH_MS) {
        return null;
    }

    return new Date(ms).toISOString();
}
