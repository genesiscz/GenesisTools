import { existsSync, readFileSync, statSync } from "node:fs";
import { ClaudeSession } from "@genesiscz/utils/claude/session";
import { parseTurnEvents as parseClaudeTurnEvents } from "@genesiscz/utils/claude/worker-stream";
import { toWorkerEvent as codexToWorkerEvent, type StoredCodexEvent } from "@genesiscz/utils/codex/worker-stream";
import type { WorkerEvent } from "@genesiscz/utils/worker/events";
import { claudeMessagesToTurns } from "./claude";
import { codexNativeLinesToTurns } from "./codex";
import { grokNativeLinesToTurns, grokWorkerTextToTurns } from "./grok";
import { parseTranscriptLine } from "./parse-line";
import type { ResolvedTranscript } from "./resolve";
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
    const records: unknown[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const parsed = parseTranscriptLine(line);
        if (parsed) {
            records.push(parsed);
        }
    }
    return records;
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

export async function transcriptEnvelope(
    resolved: ResolvedTranscript,
    opts: SliceOptions = {}
): Promise<TranscriptEnvelope> {
    const files = [...(resolved.extraFiles ?? []), resolved.filePath];
    const turns: TranscriptTurn[] = [];
    for (const [index, file] of files.entries()) {
        turns.push(...(await turnsFromFile(resolved, file, index + 1)));
    }
    const sliced = sliceTurns(turns, opts);
    let byteSize = 0;
    try {
        byteSize = statSync(resolved.filePath).size;
        for (const extra of resolved.extraFiles ?? []) {
            byteSize += statSync(extra).size;
        }
    } catch {
        byteSize = 0;
    }
    return {
        provider: resolved.provider,
        sessionId: resolved.sessionId,
        filePath: resolved.filePath,
        byteSize,
        truncated: sliced.truncated,
        nextOffset: sliced.nextOffset,
        turns: sliced.turns,
        totals: totalsOf(turns),
        terminated: terminatedOf(turns),
    };
}
