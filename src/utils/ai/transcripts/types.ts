export type TranscriptProvider = "claude" | "grok" | "codex";

export type TranscriptRole = "user" | "assistant" | "system";

export interface TranscriptTool {
    id: string;
    name: string;
    /** Short preview (path, command, pattern). Not the full args blob. */
    inputPreview: string;
    result: string | null;
    isError: boolean;
}

export interface TranscriptTurn {
    id: string;
    role: TranscriptRole;
    at: string | null;
    text: string;
    tools: TranscriptTool[];
}

export interface TranscriptEnvelope {
    provider: TranscriptProvider;
    sessionId: string;
    filePath: string;
    byteSize: number;
    truncated: boolean;
    nextOffset: number;
    turns: TranscriptTurn[];
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
