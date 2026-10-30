import { statSync } from "node:fs";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import type { TranscriptParser } from "@genesiscz/utils/harness/parts";
import { isPartNote } from "@genesiscz/utils/harness/types";
import { logger } from "@genesiscz/utils/logger";
import type { ResolvedTranscript } from "./resolve";
import { indexedClaudeEnvelope } from "./turn-index";
import {
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
    const slot = harnessDriver(provider).parts.parse;

    if (isPartNote(slot)) {
        throw new Error(`The ${provider} harness driver has no transcript parser: ${slot.reason}`);
    }

    return slot();
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

export async function transcriptEnvelope(
    resolved: ResolvedTranscript,
    opts: SliceOptions = {}
): Promise<TranscriptEnvelope> {
    // A large Claude session reads only the lines of the requested turns (turn-index.ts); null
    // means small file, other provider, or an index that disagreed: fall through to the full parse.
    const indexed = indexedClaudeEnvelope(resolved, opts);
    if (indexed) {
        return indexed;
    }
    return (await transcriptSnapshot(resolved))(opts);
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
