import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { markBefore } from "@genesiscz/utils/ai/transcripts/file-scan";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    applyToolResult,
    backupReader,
    emptyParseState,
    finishTranscript,
    type ParseCursor,
    type ParseState,
    parseLines,
    readClaudeTranscript,
    subagentFiles,
    type UnmatchedResult,
} from "./transcript";
import type { SessionTranscript } from "./types";

const { log } = logger.scoped("session-changes");

/** One transcript file read up to its last complete line, with what its lines leave for the merge. */
interface FileFold {
    ino: number;
    /** Bytes up to and including the last newline already parsed. */
    consumed: number;
    mark: string;
    state: ParseState;
    cursor: ParseCursor;
    /** Sub-agent prompts, in line order (`ParseHooks.prompt`). */
    prompts: Array<[string, string]>;
    /** Tool results whose call is in another file, in line order (`ParseHooks.unmatched`). */
    unmatched: UnmatchedResult[];
}

interface SessionFolds {
    main: FileFold | null;
    agents: Map<string, FileFold>;
    lastUsed: number;
}

const CHUNK_BYTES = 8 * 1024 * 1024;
/** Sessions kept: the hub shows one, sometimes two. A fold holds every tool input of its files. */
const SESSIONS_KEPT = 2;
/**
 * The hub asks only when an editing command of the shown session finishes, often minutes apart: with 2 minutes, an ask
 * after a 3.5 minute pause rebuilt the folds (1.0 s CPU instead of ~0.2 s, 2026-10-08). A kept session costs ~130 MB.
 */
const IDLE_MS = 10 * 60_000;
const sessions = new Map<string, SessionFolds>();
let sweep: ReturnType<typeof setTimeout> | null = null;

function scheduleSweep(): void {
    if (sweep) {
        return;
    }

    sweep = setTimeout(() => {
        sweep = null;
        const now = Date.now();
        for (const [path, entry] of sessions) {
            if (now - entry.lastUsed > IDLE_MS) {
                sessions.delete(path);
            }
        }

        if (sessions.size > 0) {
            scheduleSweep();
        }
        // A quarter of the window: a session goes at most 12.5 minutes after its last ask, not up to 20.
    }, IDLE_MS / 4);
    // Never what keeps a process alive.
    sweep.unref?.();
}

/** The lines a full parse reads at all (`parseLines` skips the rest before parsing). */
function parsedAtAll(line: string): boolean {
    return line.includes('"promptId"') || line.includes('"tool_use"') || line.includes('"file-history-');
}

/**
 * `fold` brought up to the file's last complete line, or a new fold read from the start when the file was replaced,
 * shortened or rewritten. Null when the file ends in a line without its newline that the full parse would read
 * (it parses as JSON): the caller then parses the whole session.
 */
function advance(path: string, agentId: string | null, fold: FileFold | null): FileFold | null {
    const fd = openSync(path, "r");
    try {
        const { size, ino } = fstatSync(fd);
        const usable =
            fold !== null && fold.ino === ino && fold.consumed <= size && markBefore(fd, fold.consumed) === fold.mark;
        const current: FileFold =
            usable && fold
                ? fold
                : {
                      ino,
                      consumed: 0,
                      mark: "",
                      state: emptyParseState(),
                      cursor: { currentTurn: null },
                      prompts: [],
                      unmatched: [],
                  };
        const hooks = {
            prompt: (promptId: string, prompt: string) => current.prompts.push([promptId, prompt]),
            unmatched: (result: UnmatchedResult) => current.unmatched.push(result),
        };
        let at = current.consumed;
        let carry = Buffer.alloc(0);
        while (at < size) {
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - at));
            const got = readSync(fd, chunk, 0, chunk.length, at);
            if (got === 0) {
                break;
            }

            at += got;
            const bytes = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
            const lastNewline = bytes.lastIndexOf(10);
            if (lastNewline === -1) {
                carry = Buffer.from(bytes);
                continue;
            }

            parseLines(
                bytes.subarray(0, lastNewline).toString("utf8").split("\n"),
                agentId,
                current.state,
                current.cursor,
                hooks
            );
            current.consumed += lastNewline + 1;
            carry = Buffer.from(bytes.subarray(lastNewline + 1));
        }

        current.mark = markBefore(fd, current.consumed);
        const tail = carry.toString("utf8");
        if (tail.length > 0 && parsedAtAll(tail)) {
            try {
                SafeJSON.parse(tail, { strict: true });
                return null;
            } catch {
                // A partial line, as a full parse sees it too: skipped.
            }
        }

        return current;
    } finally {
        closeSync(fd);
    }
}

/**
 * The full parse's state from the folds, on copies, in the full parse's order: main, then each sub-agent as
 * `subagentFiles` lists them. A sub-agent's results for calls of earlier files apply first, then its prompts fill
 * main turns still without one, then its calls join, and the calls it added take the launching call's turn when
 * their own turn is not a main turn (`parseClaudeTranscript`).
 */
function merge(main: FileFold, agents: Array<{ fold: FileFold; parentToolUseId: string | null }>): ParseState {
    const state: ParseState = {
        calls: new Map([...main.state.calls].map(([id, call]) => [id, { ...call }])),
        inputs: new Map(main.state.inputs),
        turns: new Map([...main.state.turns].map(([id, turn]) => [id, { ...turn }])),
        cwds: new Set(main.state.cwds),
        promptOfMessage: new Map(main.state.promptOfMessage),
        backups: [...main.state.backups],
    };

    for (const { fold, parentToolUseId } of agents) {
        const before = new Set(state.calls.keys());
        for (const cwd of fold.state.cwds) {
            state.cwds.add(cwd);
        }

        for (const result of fold.unmatched) {
            const call = state.calls.get(result.toolUseId);
            if (call) {
                applyToolResult(state, call, result);
            }
        }

        for (const [promptId, prompt] of fold.prompts) {
            const turn = state.turns.get(promptId);
            if (turn && turn.prompt === "") {
                turn.prompt = prompt;
            }
        }

        for (const [id, input] of fold.state.inputs) {
            state.inputs.set(id, input);
        }

        for (const [id, call] of fold.state.calls) {
            state.calls.set(id, { ...call });
        }

        const parentTurn = parentToolUseId ? state.calls.get(parentToolUseId)?.turnId : undefined;
        for (const [id, call] of state.calls) {
            if (!before.has(id) && parentTurn && !state.turns.has(call.turnId)) {
                call.turnId = parentTurn;
            }
        }
    }

    return state;
}

/**
 * `readClaudeTranscript`, reading only what each file gained since the last call in this process: a resident
 * process (the hub server) answers the hub's per-tool-row asks for a live session without reading the whole
 * session again (223 MB main + 366 MB of sub-agents cost ~1.5 s per ask, 2026-10-08). Falls back to the full read
 * when a file ends in a complete line without its newline, or a file cannot be read.
 */
export function readClaudeTranscriptFolded(
    transcriptPath: string,
    { minBytes = CHUNK_BYTES }: { minBytes?: number } = {}
): SessionTranscript {
    const sessionId = basename(transcriptPath).replace(/\.jsonl$/, "");
    try {
        // A small session parses whole in a few ms: not worth the memory a fold holds.
        if (statSync(transcriptPath).size < minBytes) {
            sessions.delete(transcriptPath);
            return readClaudeTranscript(transcriptPath);
        }

        const kept = sessions.get(transcriptPath) ?? { main: null, agents: new Map(), lastUsed: 0 };
        kept.lastUsed = Date.now();
        sessions.delete(transcriptPath);
        sessions.set(transcriptPath, kept);
        if (sessions.size > SESSIONS_KEPT) {
            const oldest = sessions.keys().next().value;
            if (oldest !== undefined) {
                sessions.delete(oldest);
            }
        }

        scheduleSweep();
        const main = advance(transcriptPath, null, kept.main);
        kept.main = main;
        if (!main) {
            return readClaudeTranscript(transcriptPath);
        }

        const files = subagentFiles(transcriptPath);
        const agents: Array<{ fold: FileFold; parentToolUseId: string | null }> = [];
        const seen = new Set<string>();
        for (const file of files) {
            seen.add(file.path);
            const fold = advance(file.path, file.agentId, kept.agents.get(file.path) ?? null);
            if (!fold) {
                kept.agents.delete(file.path);
                return readClaudeTranscript(transcriptPath);
            }

            kept.agents.set(file.path, fold);
            agents.push({ fold, parentToolUseId: file.parentToolUseId });
        }

        for (const path of kept.agents.keys()) {
            if (!seen.has(path)) {
                kept.agents.delete(path);
            }
        }

        log.debug({ transcriptPath, subagents: agents.length }, "session transcript from folds");
        return finishTranscript(sessionId, merge(main, agents), backupReader(sessionId));
    } catch (error) {
        log.debug({ error, transcriptPath }, "session transcript fold failed; reading it whole");
        sessions.delete(transcriptPath);
        return readClaudeTranscript(transcriptPath);
    }
}
