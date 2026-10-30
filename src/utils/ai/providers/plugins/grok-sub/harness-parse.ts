import { readFileSync } from "node:fs";
import { grokNativeLinesToTurns, grokWorkerTextToTurns } from "@genesiscz/utils/ai/transcripts/grok";
import { readTranscriptRecords } from "@genesiscz/utils/ai/transcripts/record-cache";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import type { TranscriptParser } from "@genesiscz/utils/harness/parts";

/** Grok transcripts to turns: a native chat history or a worker text file. Moved from `TURN_READERS` in load.ts. */
/** A window of `updates.jsonl` records to turns (`TranscriptFacts.windowTurns`). */
export function grokWindowTurns(values: Record<string, unknown>[]): TranscriptTurn[] {
    return grokNativeLinesToTurns(values);
}

export const grokParse: TranscriptParser = {
    fromFile: async (resolved, path, index) => {
        if (resolved.source === "worker") {
            return grokWorkerTextToTurns(readFileSync(path, "utf8"), resolved.sessionId, index);
        }

        return grokNativeLinesToTurns(readTranscriptRecords(path));
    },
    fromLines: (resolved, lines) =>
        resolved.source === "worker"
            ? grokWorkerTextToTurns(lines.join("\n"), resolved.sessionId)
            : grokNativeLinesToTurns(lines),
    // Grok's lines are not read for full inputs; its calls keep their preview.
    toolInputKeys: () => new Map(),
};
