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
