import { readFileSync } from "node:fs";
import { grokNativeLinesToTurns, grokWorkerTextToTurns } from "@genesiscz/utils/ai/transcripts/grok";
import { readTranscriptRecords } from "@genesiscz/utils/ai/transcripts/record-cache";
import type { TranscriptParser } from "@genesiscz/utils/harness/parts";

/** Grok transcripts to turns: a native chat history or a worker text file. Moved from `TURN_READERS` in load.ts. */
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
    // Grok's chat history adds nothing to its turns (no usage, no model), so insights does not read it again.
    nativeInsights: null,
};
