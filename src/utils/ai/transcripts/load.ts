import { statSync } from "node:fs";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import type { TranscriptParser } from "@genesiscz/utils/harness/parts";
import { logger } from "@genesiscz/utils/logger";
import type { ResolvedTranscript } from "./resolve";
import { INDEX_MIN_BYTES, indexedClaudeEnvelope } from "./turn-index";
import {
    DEFAULT_TURN_LIMIT,
    type SliceOptions,
    sliceTurns,
    type TranscriptEnvelope,
    type TranscriptProvider,
    type TranscriptTurn,
    terminatedOf,
    totalsOf,
} from "./types";

/** The transcript parser of a provider: its harness driver's `parse` part, loaded on first use. */
export async function transcriptParser(provider: TranscriptProvider): Promise<TranscriptParser> {
    return harnessDriver(provider).parts.parse();
}

async function turnsFromFile(resolved: ResolvedTranscript, path: string, index = 1): Promise<TranscriptTurn[]> {
    return (await transcriptParser(resolved.provider)).fromFile(resolved, path, index);
}

/** Every turn of the transcript by a full parse, earlier chain files first; the array index is the global turn index. */
export async function allTranscriptTurns(resolved: ResolvedTranscript): Promise<TranscriptTurn[]> {
    const files = [...(resolved.extraFiles ?? []), resolved.filePath];
    const turns: TranscriptTurn[] = [];
    for (const [index, file] of files.entries()) {
        turns.push(...(await turnsFromFile(resolved, file, index + 1)));
    }
    return turns;
}

/** Tail windows a bounded read tries, smallest first (the widget's tail reply reads the same sizes). */
const TAIL_WINDOWS = [256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024] as const;

export interface EnvelopeReadOptions {
    /**
     * A tail request (no offset, no turn list) on a transcript without a turn index reads only the end of its file
     * (`transcriptTailEnvelope`) once the file is `tailMinBytes` or more. For a caller that shows the newest turns and
     * never pages by session-wide offset: the phone gateway. The hub's paging and live follow need those offsets, so
     * they leave it off and keep the full parse a transcript without an index needs for them.
     */
    boundedTail?: boolean;
    /** Below this a full parse is cheap and exact (`INDEX_MIN_BYTES`, about 35 ms). */
    tailMinBytes?: number;
    tailWindows?: readonly number[];
}

export async function transcriptEnvelope(
    resolved: ResolvedTranscript,
    opts: SliceOptions = {},
    read: EnvelopeReadOptions = {}
): Promise<TranscriptEnvelope> {
    // A large Claude session reads only the lines of the requested turns (turn-index.ts); null
    // means small file, other provider, or an index that disagreed: fall through to the full parse.
    const indexed = indexedClaudeEnvelope(resolved, opts);
    if (indexed) {
        return indexed;
    }

    if (read.boundedTail && opts.offset === undefined && !opts.turns) {
        const tail = await transcriptTailEnvelope(resolved, opts.limit ?? DEFAULT_TURN_LIMIT, read);
        if (tail) {
            return tail;
        }
    }

    return (await transcriptSnapshot(resolved))(opts);
}

/**
 * The newest `limit` turns, from growing windows of the end of the transcript's last file, parsed by its provider's
 * reader (`TranscriptParser.fromLines`), so a large transcript without a turn index costs a window and not a parse of
 * every turn. The first turn of a window may have started before it, so a window must hold one turn more than asked.
 *
 * A window knows no session-wide position: the envelope says `window: "tail"`, has no `turnCount` and no `totals`,
 * and its `nextOffset` counts only the returned turns. Null, for the full parse, when the file is small, or no window
 * short of the whole file holds enough turns (a chain whose last file is short, turns longer than the window).
 */
export async function transcriptTailEnvelope(
    resolved: ResolvedTranscript,
    limit: number,
    { tailMinBytes = INDEX_MIN_BYTES, tailWindows = TAIL_WINDOWS }: EnvelopeReadOptions = {}
): Promise<TranscriptEnvelope | null> {
    const size = transcriptByteSize(resolved);

    if (size < tailMinBytes) {
        return null;
    }

    const parser = await transcriptParser(resolved.provider);

    for (const bytes of tailWindows) {
        let read: ReturnType<typeof readLastLines>;

        try {
            read = readLastLines(resolved.filePath, { maxBytes: bytes });
        } catch (error) {
            logger.debug({ error, file: resolved.filePath }, "transcript tail: the file could not be read");
            return null;
        }

        // The window reached the start of the file: the full parse reads as much and knows every position.
        if (read.wholeFile) {
            return null;
        }

        const turns = parser.fromLines(resolved, read.lines);

        if (turns.length > limit) {
            const page = turns.slice(-limit);
            logger.debug(
                { file: resolved.filePath, bytes, size, lines: read.lines.length, turns: page.length },
                "transcript tail: read a window instead of the whole transcript"
            );
            return {
                provider: resolved.provider,
                sessionId: resolved.sessionId,
                filePath: resolved.filePath,
                byteSize: size,
                truncated: true,
                nextOffset: page.length,
                turns: page,
                terminated: terminatedOf(page),
                window: "tail",
            };
        }
    }

    logger.debug(
        { file: resolved.filePath, size, limit, windows: tailWindows },
        "transcript tail: no window held the page; parsing the whole transcript"
    );
    return null;
}

/** The transcript's bytes on disk, its extra files included; 0 when a file cannot be read. No parse. */
export function transcriptByteSize(resolved: ResolvedTranscript): number {
    try {
        let size = statSync(resolved.filePath).size;

        for (const extra of resolved.extraFiles ?? []) {
            size += statSync(extra).size;
        }

        return size;
    } catch (error) {
        logger.debug({ error, file: resolved.filePath }, "transcript size: a file could not be read");
        return 0;
    }
}

/** One caller-owned parse for a catch-up drain; discarded before the next file-growth wake. */
export async function transcriptSnapshot(
    resolved: ResolvedTranscript
): Promise<(opts?: SliceOptions) => TranscriptEnvelope> {
    const turns = await allTranscriptTurns(resolved);
    const totals = totalsOf(turns);
    const terminated = terminatedOf(turns);
    const byteSize = transcriptByteSize(resolved);
    return (opts = {}) => {
        const sliced = sliceTurns(turns, opts);
        return {
            provider: resolved.provider,
            sessionId: resolved.sessionId,
            filePath: resolved.filePath,
            byteSize,
            truncated: sliced.truncated,
            nextOffset: sliced.nextOffset,
            turns: sliced.turns,
            totals,
            terminated,
            turnCount: turns.length,
        };
    };
}
