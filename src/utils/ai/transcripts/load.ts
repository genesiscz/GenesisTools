import { existsSync, readFileSync, statSync } from "node:fs";
import { ClaudeSession } from "@genesiscz/utils/claude/session";
import { parseTurnEvents as parseClaudeTurnEvents } from "@genesiscz/utils/claude/worker-stream";
import { toWorkerEvent as codexToWorkerEvent, type StoredCodexEvent } from "@genesiscz/utils/codex/worker-stream";
import type { WorkerEvent } from "@genesiscz/utils/worker/events";
import { claudeMessagesToTurns } from "./claude";
import { codexNativeLinesToTurns, createCodexTurnParser } from "./codex";
import { grokNativeLinesToTurns, grokWorkerTextToTurns } from "./grok";
import { readRecordsAppendOnly } from "./record-cache";
import type { ResolvedTranscript } from "./resolve";
import { foldTurnsAppendOnly } from "./turn-fold-cache";
import { indexedClaudeEnvelope } from "./turn-index";
import {
    type SliceOptions,
    sliceTurns,
    type TranscriptEnvelope,
    type TranscriptTurn,
    terminatedOf,
    totalsOf,
} from "./types";
import { workerEventsToTurns } from "./worker-events";

function readRecords(path: string): unknown[] {
    if (!existsSync(path)) {
        return [];
    }
    // A live Codex or Grok file is read again on every write: only its new lines are parsed (record-cache.ts).
    return readRecordsAppendOnly(path);
}

function looksLikeCodexGt(records: unknown[]): boolean {
    for (const record of records) {
        if (record && typeof record === "object" && "method" in record) {
            return true;
        }
    }
    return false;
}

async function turnsFromFile(resolved: ResolvedTranscript, path: string, index = 1): Promise<TranscriptTurn[]> {
    if (resolved.provider === "claude") {
        if (resolved.source === "worker") {
            // A `claude -p --output-format stream-json` turn file, not a session file.
            return workerEventsToTurns(
                parseClaudeTurnEvents(readFileSync(path, "utf8"), resolved.sessionId),
                resolved.sessionId,
                index
            );
        }

        const session = await ClaudeSession.fromFile(path);
        return claudeMessagesToTurns(session.messages);
    }
    if (resolved.provider === "grok") {
        if (resolved.source === "worker") {
            return grokWorkerTextToTurns(readFileSync(path, "utf8"), resolved.sessionId, index);
        }
        return grokNativeLinesToTurns(readRecords(path));
    }
    if (resolved.source !== "worker") {
        // A large native rollout keeps its parser between reads and parses only appended lines (turn-fold-cache.ts).
        const folded = foldTurnsAppendOnly(path, createCodexTurnParser);
        if (folded) {
            return folded;
        }
    }

    const records = readRecords(path);
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

/** One caller-owned parse for a catch-up drain; discarded before the next file-growth wake. */
export async function transcriptSnapshot(
    resolved: ResolvedTranscript
): Promise<(opts?: SliceOptions) => TranscriptEnvelope> {
    const turns = await allTranscriptTurns(resolved);
    const totals = totalsOf(turns);
    const terminated = terminatedOf(turns);
    let byteSize = 0;
    try {
        byteSize = statSync(resolved.filePath).size;
        for (const extra of resolved.extraFiles ?? []) {
            byteSize += statSync(extra).size;
        }
    } catch {
        byteSize = 0;
    }
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
