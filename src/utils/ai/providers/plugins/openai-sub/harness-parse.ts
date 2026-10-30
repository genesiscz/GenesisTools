import { codexHistoryReader } from "@genesiscz/utils/agent-sessions/compact-readers";
import { codexToolInputLine } from "@genesiscz/utils/agent-sessions/readers/codex-tool-inputs";
import { codexNativeLinesToTurns, createCodexTurnParser } from "@genesiscz/utils/agent-sessions/readers/codex-turns";
import { codexModelOf, toolInputKeysOf } from "@genesiscz/utils/ai/transcripts/native-scan";
import { parseTranscriptLine } from "@genesiscz/utils/ai/transcripts/parse-line";
import { readTranscriptRecords } from "@genesiscz/utils/ai/transcripts/record-cache";
import type { ResolvedTranscript } from "@genesiscz/utils/ai/transcripts/resolve";
import { foldTurnsAppendOnly } from "@genesiscz/utils/ai/transcripts/turn-fold-cache";
import type { TranscriptTurn } from "@genesiscz/utils/ai/transcripts/types";
import { workerEventsToTurns } from "@genesiscz/utils/ai/transcripts/worker-events";
import { toWorkerEvent as codexToWorkerEvent, type StoredCodexEvent } from "@genesiscz/utils/codex/worker-stream";
import type { TranscriptParser } from "@genesiscz/utils/harness/parts";
import type { WorkerEvent } from "@genesiscz/utils/worker/events";

export const codexWindowTurns = codexHistoryReader.windowTurns;

/** Codex transcripts to turns: a native rollout (folded append-only when large) or stored worker events. Moved from `TURN_READERS` in load.ts. */
/** A window of rollout records to turns (`TranscriptFacts.windowTurns`). */
export function codexWindowTurns(values: Record<string, unknown>[]): TranscriptTurn[] {
    return codexNativeLinesToTurns(values);
}

export const codexParse: TranscriptParser = {
    fromFile: async (resolved, path, index) => {
        if (resolved.source !== "worker") {
            // A large native rollout keeps its parser between reads and parses only appended lines (turn-fold-cache.ts).
            const folded = foldTurnsAppendOnly(path, createCodexTurnParser);
            if (folded) {
                return folded;
            }
        }

        return codexTurns(resolved, readTranscriptRecords(path), index);
    },
    fromLines: (resolved, lines) => {
        const records = lines.map(parseTranscriptLine).filter((record) => record !== null);
        return codexTurns(resolved, records, 1);
    },
    toolInputKeys: (text) => toolInputKeysOf(text, codexToolInputLine),
    // A rollout's turns name no model, so insights takes the session's own. Moved from NATIVE_INSIGHTS.
    nativeInsights: (text) => ({ native: null, defaultModel: codexModelOf(text) }),
};

function looksLikeCodexGt(records: unknown[]): boolean {
    for (const record of records) {
        if (record && typeof record === "object" && "method" in record) {
            return true;
        }
    }
    return false;
}

function codexTurns(resolved: ResolvedTranscript, records: unknown[], index: number): TranscriptTurn[] {
    if (resolved.source === "worker" || looksLikeCodexGt(records)) {
        // The codex CLI's own event mapping, not a second guess at it: the
        // stored notifications are `item/started`, `item/completed`,
        // `turn/completed`, and a private matcher on method substrings dropped
        // every one of them (PR #364 review).
        const events = records
            .map((record) => codexToWorkerEvent(record as StoredCodexEvent))
            .filter((event): event is WorkerEvent => event !== null);
        return workerEventsToTurns(events, resolved.sessionId, index);
    }
    return codexNativeLinesToTurns(records);
}
