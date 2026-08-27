import { existsSync, readFileSync, statSync } from "node:fs";
import { ClaudeSession } from "@genesiscz/utils/claude/session";
import { parseJsonl } from "@genesiscz/utils/jsonl";
import { claudeMessagesToTurns } from "./claude";
import { codexGtEventsToTurns, codexNativeLinesToTurns } from "./codex";
import { grokNativeLinesToTurns, grokWorkerTextToTurns } from "./grok";
import type { ResolvedTranscript } from "./resolve";
import { type SliceOptions, sliceTurns, type TranscriptEnvelope, type TranscriptTurn } from "./types";

function readRecords(path: string): unknown[] {
    if (!existsSync(path)) {
        return [];
    }
    return parseJsonl(readFileSync(path));
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
        return codexGtEventsToTurns(records);
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
    };
}
