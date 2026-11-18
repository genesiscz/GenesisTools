import { basename, dirname, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { analyzeCommand } from "@genesiscz/utils/session-changes/command";
import { fileToolVia, isShellTool } from "@genesiscz/utils/session-changes/tool-calls";
import type { WindowWriter } from "../types";
import { advanceLines, type LineFold } from "./changes-window-cache";
import { claudeChangeUse, historyBackups, PARSED_LINE_MARKERS } from "./claude-changes-parse";

const [PROMPT, USE, HISTORY] = PARSED_LINE_MARKERS.map((s) => Buffer.from(s));
const CWD = Buffer.from('"cwd"');
const RESULT = Buffer.from('"tool_use_id"');
const ERROR = Buffer.from('"is_error"');
const UNICODE = Buffer.from("\\u");

interface LedgerEntry {
    id: string;
    offset: number;
    at: number | null;
}
interface FactCall {
    id: string;
    kind: "file" | "shell";
    offset: number;
    at: number | null;
    dir: string | null;
    writes: string[];
    scripts: string[];
    hasCommand: boolean;
    wildcard: boolean;
}

function emptyFacts() {
    return {
        ledger: new Map<string, LedgerEntry>(),
        promptIds: new Set<string>(),
        cwds: new Set<string>(),
        calls: new Map<string, FactCall>(),
        errorIds: new Set<string>(),
        resultIds: new Set<string>(),
        // The last result's timestamp decides whether matchRows can resolve its call by id.
        finishedTurns: new Map<string, string | null>(),
        duplicateIds: false,
        newestBackupTime: new Map<string, number>(),
        backupOffsets: new Map<string, number>(),
        cursor: null as string | null,
        unplaced: false,
    };
}
export type FileFacts = ReturnType<typeof emptyFacts>;
export type FoldedFacts = LineFold<FileFacts>;

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** The common compact string spelling. Ambiguous, escaped or spaced fields take the JSON path. */
function singleString(bytes: Buffer, key: Buffer, pos: number): string | undefined {
    const start = pos + key.length;
    if (bytes[start] !== 58 || bytes[start + 1] !== 34) {
        return undefined;
    }
    const end = bytes.indexOf(34, start + 2);
    if (end === -1 || bytes[end - 1] === 92 || bytes.indexOf(key, end + 1) !== -1) {
        return undefined;
    }
    const value = bytes.toString("utf8", start + 2, end);
    return value.includes("\\") ? undefined : value;
}

export function advanceClaudeFacts(path: string, main: boolean, kept?: FoldedFacts): FoldedFacts {
    return advanceLines({
        path,
        kept,
        initial: emptyFacts,
        line(facts, bytes, offset) {
            const promptPos = bytes.indexOf(PROMPT);
            const hasUse = bytes.includes(USE);
            const history = bytes.includes(HISTORY);
            if (promptPos < 0 && !hasUse && !history) {
                return;
            }

            const cwdPos = bytes.indexOf(CWD);
            const knownCwd = cwdPos < 0 || facts.cwds.has(singleString(bytes, CWD, cwdPos) ?? "");
            const prompt = promptPos < 0 ? undefined : singleString(bytes, PROMPT, promptPos);
            const knownPrompt = promptPos < 0 || (prompt !== undefined && prompt === facts.cursor);
            const resultPos = bytes.indexOf(RESULT);
            const fastId = resultPos < 0 ? undefined : singleString(bytes, RESULT, resultPos);
            const ownCall = fastId ? facts.calls.get(fastId) : undefined;
            const errorPos = bytes.indexOf(ERROR);
            const commonSuccess =
                errorPos < 0 ||
                (bytes.subarray(errorPos + ERROR.length, errorPos + ERROR.length + 6).toString() === ":false" &&
                    bytes.indexOf(ERROR, errorPos + ERROR.length) === -1);
            if (
                !hasUse &&
                !history &&
                knownCwd &&
                knownPrompt &&
                commonSuccess &&
                (resultPos < 0 ||
                    (fastId && (main || ownCall) && ownCall?.kind !== "shell" && !facts.errorIds.has(fastId))) &&
                !bytes.includes(UNICODE)
            ) {
                if (fastId) {
                    facts.resultIds.add(fastId);
                }
                return;
            }

            let entry: Record<string, unknown> | null;
            try {
                entry = object(SafeJSON.parse(bytes.toString(), { strict: true }));
            } catch {
                return;
            }
            if (!entry) {
                return;
            }
            if (entry.type === "file-history-snapshot" || entry.type === "file-history-delta") {
                if (main) {
                    for (const backup of historyBackups(entry)) {
                        if (backup.messageId && !facts.backupOffsets.has(backup.messageId)) {
                            facts.backupOffsets.set(backup.messageId, offset);
                        }
                        if (backup.backup !== null && backup.backupTime !== null) {
                            facts.newestBackupTime.set(
                                backup.backup,
                                Math.max(facts.newestBackupTime.get(backup.backup) ?? 0, backup.backupTime)
                            );
                        }
                    }
                }
                return;
            }
            const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
            if (cwd) {
                facts.cwds.add(cwd);
            }
            const at = typeof entry.timestamp === "string" ? entry.timestamp : null;
            if (typeof entry.promptId === "string" && entry.promptId) {
                facts.promptIds.add(entry.promptId);
                if (entry.type === "user") {
                    facts.cursor = entry.promptId;
                    if (main && !facts.ledger.has(entry.promptId)) {
                        const ms = at ? Date.parse(at) : NaN;
                        facts.ledger.set(entry.promptId, {
                            id: entry.promptId,
                            offset,
                            at: Number.isFinite(ms) ? ms : null,
                        });
                    }
                }
            }
            const content = object(entry.message)?.content;
            for (const raw of Array.isArray(content) ? content : []) {
                const block = object(raw);
                if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
                    const id = block.tool_use_id;
                    facts.resultIds.add(id);
                    if (at && Number.isFinite(Date.parse(at)) && typeof entry.promptId === "string") {
                        facts.finishedTurns.set(id, entry.promptId);
                    } else {
                        facts.finishedTurns.set(id, null);
                    }
                    if (block.is_error === true) {
                        facts.errorIds.add(id);
                    } else {
                        facts.errorIds.delete(id);
                    }
                    continue;
                }
                if (block?.type !== "tool_use" || entry.type !== "assistant") {
                    continue;
                }
                const use = claudeChangeUse(block, cwd, at);
                if (!use) {
                    continue;
                }
                const { id, name, filePath, command } = use;
                const via = fileToolVia(name);
                if (!via && !isShellTool(name)) {
                    continue;
                }
                facts.unplaced ||= !facts.cursor;
                const writes = new Map<string, string>();
                const scripts: string[] = [];
                let wildcard = false;
                if (via && filePath) {
                    writes.set(resolve(filePath), "");
                }
                if (command) {
                    analyzeCommand({
                        command,
                        cwd: cwd ?? "/",
                        files: writes,
                        onScript: (path) => scripts.push(basename(path)),
                    });
                    wildcard = !cwd && writes.size > 0;
                }
                facts.errorIds.delete(id);
                facts.finishedTurns.delete(id);
                facts.duplicateIds ||= facts.calls.has(id);
                facts.calls.set(id, {
                    id,
                    kind: via ? "file" : "shell",
                    offset,
                    at: use.startedAt,
                    dir: via && filePath ? dirname(filePath) : null,
                    writes: [...writes.keys()],
                    scripts,
                    hasCommand: command !== null,
                    wildcard,
                });
            }
        },
    });
}

export function sessionFacts(files: ReadonlyMap<string, FoldedFacts>) {
    const cwds = new Set<string>();
    const errors = new Set<string>();
    const scripts = new Set<string>();
    const shellCalls = new Set<string>();
    let ambiguous = false;
    for (const { state } of files.values()) {
        for (const cwd of state.cwds) {
            cwds.add(cwd);
        }
        for (const call of state.calls.values()) {
            for (const path of call.writes) {
                // Even a script with no heredoc can invoke one that writes files.
                scripts.add(basename(path));
            }
        }
        ambiguous ||= state.duplicateIds;
    }
    const calls = new Map<string, { path: string; offset: number }>();
    const fileDirs = new Map<string, string>();
    const finishedShellTurns = new Map<string, string>();
    const commands = new Set<string>();
    const dirs = new Set<string>();
    const writers = new Map<string, WindowWriter[]>();
    const wildcards: WindowWriter[] = [];
    const invocations: WindowWriter[] = [];
    for (const [path, { state }] of files) {
        // As in merge(): apply this file's cross-file results before inserting its own calls.
        for (const id of state.resultIds) {
            if (calls.has(id) && !state.calls.has(id)) {
                const turn = state.finishedTurns.get(id);
                if (turn && commands.has(id)) {
                    finishedShellTurns.set(id, turn);
                } else {
                    finishedShellTurns.delete(id);
                }
                if (state.errorIds.has(id)) {
                    errors.add(id);
                } else {
                    errors.delete(id);
                }
            }
        }
        for (const call of state.calls.values()) {
            ambiguous ||= calls.has(call.id);
            calls.set(call.id, { path, offset: call.offset });
            if (call.dir) {
                fileDirs.set(call.id, call.dir);
                if (state.errorIds.has(call.id)) {
                    errors.add(call.id);
                }
            }
            if (call.kind === "shell") {
                shellCalls.add(call.id);
                if (call.hasCommand) {
                    commands.add(call.id);
                }
                const turn = state.finishedTurns.get(call.id);
                if (call.hasCommand && turn) {
                    finishedShellTurns.set(call.id, turn);
                }
            }
            const wildcard = call.wildcard || call.scripts.some((name) => scripts.has(name));
            const writer = { callId: call.id, at: call.at, wildcard };
            if (call.scripts.length && !wildcard) {
                invocations.push(writer);
            }
            if (wildcard) {
                wildcards.push(writer);
            } else {
                for (const target of call.writes) {
                    const list = writers.get(target) ?? [];
                    list.push(writer);
                    writers.set(target, list);
                }
            }
        }
    }
    for (const [id, dir] of fileDirs) {
        if (!errors.has(id)) {
            dirs.add(dir);
        }
    }
    const byTime = (a: WindowWriter, b: WindowWriter) => (a.at ?? 0) - (b.at ?? 0);
    // An indirect heredoc can create another script whose name never appeared in a direct write.
    const firstIndirect = wildcards.reduce((first, writer) => Math.min(first, writer.at ?? 0), Infinity);
    for (const writer of invocations) {
        if ((writer.at ?? 0) >= firstIndirect) {
            wildcards.push({ ...writer, wildcard: true });
        }
    }
    wildcards.sort(byTime);
    const sorted = new Map<string, WindowWriter[]>();
    return {
        cwds: [...cwds],
        editedDirs: [...dirs],
        shellCalls,
        finishedShellTurns,
        calls,
        ambiguous,
        writersOf(path: string): readonly WindowWriter[] {
            const direct = writers.get(path);
            if (!direct) {
                return wildcards;
            }
            let list = sorted.get(path);
            if (!list) {
                list = [...direct, ...wildcards].sort(byTime);
                sorted.set(path, list);
            }
            return list;
        },
    };
}
