import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { analyzeCommand } from "@genesiscz/utils/session-changes/command";
import { fileToolVia, isShellTool } from "@genesiscz/utils/session-changes/tool-calls";
import { advanceClaudeFacts, sessionFacts } from "./claude-changes-facts";
import {
    emptyParseState,
    isParsedLine,
    type ParseCursor,
    parseLines,
    readClaudeTranscript,
    subagentFiles,
} from "./claude-changes-parse";

/** Offline invariant checks. Stream the actual records independently of the optimized facts scan. */
export function auditClaudeChanges(path: string) {
    const prompts = new Map<string, number>();
    const messages = new Map<string, string>();
    const snapshots: Array<{ id: string; line: number }> = [];
    const counts = {
        snapshots: 0,
        earlySnapshots: 0,
        beyondPrevious: 0,
        subagents: 0,
        newerThanMtime: 0,
        phantomCapable: 0,
        malformed: 0,
    };
    for (const file of [{ path, agentId: null }, ...subagentFiles(path)]) {
        const mtime = statSync(file.path).mtimeMs;
        let newer = false;
        let foreign = false;
        let line = 0;
        for (const raw of readLinesSync(file.path)) {
            line++;
            let entry: Record<string, unknown>;
            try {
                entry = SafeJSON.parse(raw, { strict: true });
            } catch {
                counts.malformed++;
                continue;
            }
            if (!entry || typeof entry !== "object") {
                continue;
            }
            if (file.agentId !== null) {
                newer ||= typeof entry.timestamp === "string" && Date.parse(entry.timestamp) > mtime;
                foreign ||= typeof entry.promptId === "string" && !prompts.has(entry.promptId);
                continue;
            }
            if (!isParsedLine(raw)) {
                continue;
            }
            if (entry.type === "user" && typeof entry.promptId === "string" && entry.promptId) {
                if (!prompts.has(entry.promptId)) {
                    prompts.set(entry.promptId, line);
                }
                if (typeof entry.uuid === "string") {
                    messages.set(entry.uuid, entry.promptId);
                }
            } else if (entry.type === "file-history-snapshot") {
                const snapshot = entry.snapshot;
                const id =
                    entry.messageId ??
                    (snapshot && typeof snapshot === "object" && "messageId" in snapshot ? snapshot.messageId : null);
                if (typeof id === "string") {
                    snapshots.push({ id, line });
                }
            }
        }
        if (file.agentId !== null) {
            counts.subagents++;
            counts.newerThanMtime += Number(newer);
            counts.phantomCapable += Number(foreign);
        }
    }
    const starts = [...prompts.values()];
    const previous = new Map([...prompts.keys()].map((id, i) => [id, starts[i - 1] ?? 0]));
    for (const snapshot of snapshots) {
        const id = messages.get(snapshot.id);
        if (id) {
            counts.snapshots++;
            counts.earlySnapshots += Number(snapshot.line < (prompts.get(id) ?? 0));
            counts.beyondPrevious += Number(snapshot.line < (previous.get(id) ?? 0));
        }
    }
    return counts;
}

/** Compare independently parsed session facts with the same session from the full parser. */
export function auditClaudeFacts(path: string) {
    const files = new Map([[path, advanceClaudeFacts(path, true)]]);
    for (const file of subagentFiles(path)) {
        files.set(file.path, advanceClaudeFacts(file.path, false));
    }
    const facts = sessionFacts(files);
    const full = readClaudeTranscript(path);
    const editedDirs = [
        ...new Set(
            full.calls
                .filter((call) => fileToolVia(call.name) && call.filePath && !call.isError)
                .map((call) => dirname(call.filePath ?? ""))
        ),
    ];
    const shellCalls = full.calls.filter((call) => isShellTool(call.name)).map((call) => call.id);
    // Byte offsets are independently counted from decoded lines. The full parser supplies the first
    // turn, the call ids and checkpoint fields. No optimized byte predicates enter this oracle.
    let positions = true;
    let checkpoints = true;
    let ledger = true;
    for (const [file, fold] of files) {
        const state = emptyParseState();
        const cursor: ParseCursor = { currentTurn: null };
        const turns: Array<{ id: string; offset: number; at: number | null }> = [];
        const offsets = new Map<string, number>();
        const idIterator = state.calls.keys();
        const turnIterator = state.turns.values();
        let offset = 0;
        for (const line of readLinesSync(file)) {
            // Map iterators become exhausted after the last item. New ids are read by count below.
            const beforeCalls = state.calls.size;
            const beforeTurns = state.turns.size;
            parseLines([line], file === path ? null : file, state, cursor);
            for (let i = beforeCalls; i < state.calls.size; i++) {
                const id = idIterator.next().value;
                if (id !== undefined && fold.state.calls.has(id)) {
                    offsets.set(id, offset);
                }
            }
            if (state.turns.size > beforeTurns) {
                const turn = turnIterator.next().value;
                if (turn) {
                    const ms = turn.at ? Date.parse(turn.at) : NaN;
                    turns.push({ id: turn.turnId, offset, at: Number.isFinite(ms) ? ms : null });
                }
            }
            offset += Buffer.byteLength(line) + 1;
        }
        positions &&= [...fold.state.calls].every(([id, call]) => offsets.get(id) === call.offset);
        ledger &&= isDeepStrictEqual(turns, [...fold.state.ledger.values()]);
        const newest = new Map<string, number>();
        for (const item of state.backups) {
            if (item.backup !== null && item.backupTime !== null) {
                newest.set(item.backup, Math.max(newest.get(item.backup) ?? 0, item.backupTime));
            }
        }
        checkpoints &&= isDeepStrictEqual(newest, fold.state.newestBackupTime);
    }

    let writers = true;
    let writerId = "";
    class ObservedWrites extends Map<string, string> {
        override set(path: string, text: string): this {
            writers &&= facts.writersOf(path).some((writer) => writer.callId === writerId);
            return super.set(path, text);
        }
    }
    const written = new ObservedWrites();
    for (const call of [...full.calls].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))) {
        writerId = call.id;
        if (fileToolVia(call.name) && call.filePath) {
            const target = resolve(call.filePath);
            writers &&= facts.writersOf(target).some((writer) => writer.callId === call.id);
            if (typeof call.after === "string") {
                written.set(target, call.after);
            }
        } else if (call.command !== null) {
            analyzeCommand({ command: call.command, cwd: call.cwd ?? full.cwds[0] ?? "/", files: written });
        }
    }
    return {
        ledger,
        positions,
        checkpoints,
        writers,
        cwds: isDeepStrictEqual(facts.cwds, full.cwds),
        editedDirs: isDeepStrictEqual(facts.editedDirs, editedDirs),
        shellCalls: isDeepStrictEqual([...facts.shellCalls], shellCalls),
        calls: isDeepStrictEqual(
            [...facts.calls.keys()],
            full.calls
                .filter(
                    (call) =>
                        fileToolVia(call.name) ||
                        isShellTool(call.name) ||
                        call.name === "Task" ||
                        call.name === "Agent"
                )
                .map((call) => call.id)
        ),
    };
}
