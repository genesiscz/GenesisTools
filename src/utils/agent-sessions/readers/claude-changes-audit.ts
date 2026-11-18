import { statSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { fileToolVia, isShellTool } from "@genesiscz/utils/session-changes/tool-calls";
import { advanceClaudeFacts, sessionFacts } from "./claude-changes-facts";
import { isParsedLine, readClaudeTranscript, subagentFiles } from "./claude-changes-parse";

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
    const ledger = [...(files.get(path)?.state.ledger.keys() ?? [])];
    return {
        ledger: isDeepStrictEqual(
            ledger,
            full.turns.map((turn) => turn.turnId)
        ),
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
