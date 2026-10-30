/**
 * Where a coding-agent session is in its CURRENT turn, read from its native transcript.
 *
 * `activity.ts` decides a state from events. Each harness driver's `turnState` part turns its transcript dialect
 * into those events (`src/utils/agent-sessions/readers/<harness>-turn-state.ts`, over the shared helpers in
 * `turn-state-core.ts`), and adds what a waiter needs beyond the state: the text of the last assistant message and
 * a marker that moves when a turn ends, so "wait for the next turn" can tell a new finish from an old one. This file
 * holds the shared shapes, the live phase over a snapshot, and the disk read.
 *
 * - Claude: `<project>/<id>.jsonl`. The last conversation record decides (`activity.ts`).
 * - Grok:   `updates.jsonl` of a TUI session. `turn_completed` ends a turn; `hook_*` records are noise. Its
 *           permission prompts are supplied by its native reader from the event log.
 * - Codex:  `rollout-*.jsonl`. `task_complete` (with `last_agent_message`) ends a turn.
 *
 * The readers are pure over parsed records. `readTurnState` is the one place that touches the disk:
 * one `stat`, one bounded tail read of the transcript (and of the event log for a provider that has one),
 * no process spawn and no write.
 */

import { existsSync, statSync } from "node:fs";
import { resolveHistoryProvider } from "@genesiscz/utils/agent-sessions/provider";
import type { NativeDialogPermission } from "@genesiscz/utils/agent-sessions/types";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessTurnState } from "@genesiscz/utils/ai/providers/harness-index";
import { isZstdPath } from "@genesiscz/utils/compress/zstd";
import type { HarnessId } from "@genesiscz/utils/harness/types";
import { logger } from "@genesiscz/utils/logger";
import type { ActivityState } from "./activity";
import { readTailAt } from "./native-scan";
import { parseTranscriptLine } from "./parse-line";

export type TurnProvider = HarnessId;

/** A turn's last records can hold a long tool result, so this is larger than the activity tail. */
export const TURN_TAIL_BYTES = 256 * 1024;

/**
 * Grok's `events.jsonl` lines are short (`phase_changed` is about 80 bytes), and a session that waits on a
 * permission prompt writes nothing after the request, so the open request is within the last few lines.
 */
export const EVENT_LOG_TAIL_BYTES = 64 * 1024;

export type JsonRecord = Record<string, unknown>;

/** What a session waits on: a question tool, a plan to approve, or a permission prompt of the harness. */
export type TurnQuestionKind = "decision" | "permission" | "plan";

/** The call a session waits on while `asksQuestion` is true. Its id is the dialog record's identity. */
export interface TurnQuestionCall {
    kind: TurnQuestionKind;
    /**
     * The call that asked: Claude's `tool_use` id, Codex's `call_id`, Grok's `toolCallId`. A Grok permission prompt
     * whose call is not in the tail gets `permission:<ISO time of the request>`.
     */
    callId: string;
    /** The option labels the question tool offered, when its input lists them. */
    options?: string[];
    questionCount?: number;
}

/** A tool call of the current turn that has no result yet. */
export interface OpenToolCall {
    id: string;
    name: string;
    /** One line that says what the call does: a Bash `description`, else its command, path, pattern or query. */
    summary: string;
    /** Epoch ms of the record that made the call; null when it carried no time. */
    startedAt: number | null;
}

export interface TurnSnapshot {
    state: ActivityState;
    /** The text of the last assistant message. Empty when the tail holds none. */
    lastText: string;
    /**
     * True when the session waits on a question for the user: the turn ended on one (Claude `AskUserQuestion`,
     * Codex `request_user_input_async`), or a blocking question tool has no answer yet (Codex
     * `request_user_input`, Grok `ask_user_question` or `exit_plan`). Decided from the tool calls, never from
     * the wording of the message.
     */
    asksQuestion: boolean;
    /**
     * The text of the newest question tool call in the current turn, answered or not. A Codex
     * `request_user_input_async` asked while the turn keeps running shows up here with `asksQuestion` false.
     */
    question: string | null;
    /**
     * The call the session waits on, set by all three readers whenever `asksQuestion` is true and the call carries an
     * id. Absent while nothing waits. Optional only so the hand-built snapshots of other modules' tests stay valid;
     * every reader here fills it.
     */
    questionCall?: TurnQuestionCall;
    /** True when the user stopped the turn (Esc in Claude, `turn_aborted` in Codex). The turn has ended. */
    interrupted: boolean;
    /**
     * The error the turn ended with, else null: Codex writes it on `task_complete` (an API outage, a failed remote
     * compaction, a model at capacity). The turn ended without doing its work, so callers must not read it as done.
     */
    turnError: string | null;
    /** Epoch ms of the newest turn-level record. Null when the tail holds none. Grows when a turn ends. */
    lastEventAt: number | null;
    /**
     * Epoch ms of the record that opened the newest turn: Claude's user prompt, Codex `task_started`, Grok's first
     * `user_message_chunk`. Null when the tail holds none (the turn began before it). `message --wait` uses it to
     * tell the turn that answers its message from one that was already running when the message was queued.
     */
    turnStartedAt: number | null;
    /**
     * Grok only: the byte offset in the transcript of the record that opened the newest turn. Grok stamps whole
     * seconds, so two turns that open in the same second share `turnStartedAt`; the file only grows, so the one
     * that opened after a send starts at or past the size the file had before it.
     */
    turnStartOffset?: number;
    /** Byte offset of the first whole line in the disk tail. Absent for readers without a byte window. */
    tailStartOffset?: number;
    /** Earliest retained activity event, used to fence a turn whose opening record left the tail. */
    earliestTailEventAt?: number;
    /** The newer of `lastEventAt` and the file's modification time. */
    lastActivityAt: number;
    /** `now` minus `lastActivityAt`. */
    silenceMs: number;
    /** The current turn's tool calls without a result, oldest first. A new prompt or the end of a turn clears them. */
    openTools: OpenToolCall[];
    /**
     * Epoch ms the model last got the turn back: the newest tool result, else the prompt. While no call is open the
     * model has been thinking since then. Null when the tail holds neither.
     */
    handedBackAt: number | null;
}

export interface TurnStateInput {
    /** Parsed transcript records, oldest first. */
    records: ReadonlyArray<JsonRecord>;
    /** The file's modification time in epoch ms. */
    lastModified: number;
    now: number;
    /** Silence longer than this is a stall. `Number.POSITIVE_INFINITY` never stalls. */
    stallTimeoutMs: number;
    /** The byte offset in the file where each record's line starts, aligned with `records`. */
    offsets?: ReadonlyArray<number>;
    /** A normalized permission request from the provider's native reader. */
    permission?: NativeDialogPermission | null;
    /**
     * True when nothing writes the transcript any more: a `.jsonl.zst` rollout, which Codex 0.164 writes only for a
     * session it closed. The state is then `FINISHED`, whatever the last turn did; `asksQuestion`, `lastText` and the
     * rest still describe that turn.
     */
    closed?: boolean;
}

/** Where a live transcript's agent is: the one value the hub's activity row and status show. */
export type LivePhase = "thinking" | "tool" | "waiting" | "idle" | "interrupted";

export interface LiveActivity {
    phase: LivePhase;
    /** Epoch ms the current turn's prompt arrived. */
    turnStartedAt: number | null;
    /**
     * Epoch ms the phase began: the open call's start for `tool`, the newest tool result or prompt for `thinking`,
     * the newest turn record otherwise.
     */
    since: number | null;
    /** The oldest open call (`tool`), or the question tool a `waiting` turn sits on. */
    tool: OpenToolCall | null;
    /** How many calls are open at once (parallel calls). */
    openTools: number;
    /** What a `waiting` turn asks. */
    question: string | null;
    /** No transcript write for `LIVE_STALL_MS` while the turn runs: the agent process may be gone. */
    stalled: boolean;
    lastEventAt: number | null;
}

/** Silence that marks a running turn as stalled. Long: a test run or a long think writes nothing for minutes. */
export const LIVE_STALL_MS = 10 * 60_000;

/** Claude tools that stop the turn until the user answers. Grok and Codex questions arrive as `asksQuestion`. */
const WAITING_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * The live activity of a snapshot read with no stall limit (`stallTimeoutMs: Infinity`). The order decides:
 * an interrupt, a question waiting for the user, a finished turn, an open call, and otherwise the model is thinking.
 */
export function liveActivityOf(snapshot: TurnSnapshot, stallMs = LIVE_STALL_MS): LiveActivity {
    const base = {
        turnStartedAt: snapshot.turnStartedAt,
        lastEventAt: snapshot.lastEventAt,
        tool: null,
        openTools: 0,
        question: null,
        stalled: false,
    };

    if (snapshot.interrupted) {
        return { ...base, phase: "interrupted", since: snapshot.lastEventAt };
    }

    const waitingTool = snapshot.openTools.find((call) => WAITING_TOOLS.has(call.name)) ?? null;

    if (snapshot.asksQuestion || waitingTool) {
        const plan = waitingTool?.name === "ExitPlanMode" ? "Approve the plan?" : null;

        return {
            ...base,
            phase: "waiting",
            since: waitingTool?.startedAt ?? snapshot.lastEventAt,
            tool: waitingTool,
            question: plan ?? snapshot.question,
        };
    }

    if (snapshot.state === "AWAITING-INPUT" || snapshot.state === "FINISHED") {
        return { ...base, phase: "idle", since: snapshot.lastEventAt };
    }

    const stalled = snapshot.silenceMs > stallMs;
    const tool = snapshot.openTools[0] ?? null;

    if (tool) {
        return {
            ...base,
            phase: "tool",
            since: tool.startedAt ?? snapshot.lastEventAt,
            tool,
            openTools: snapshot.openTools.length,
            stalled,
        };
    }

    // One model call writes several records (thinking, text): the phase counts from the result or prompt before them.
    const since = snapshot.handedBackAt ?? snapshot.lastEventAt ?? snapshot.turnStartedAt;
    return { ...base, phase: "thinking", since, stalled };
}

export function isTurnProvider(value: string): value is TurnProvider {
    return isAccountProviderAlias(value);
}

/** The state of the newest turn, read by the harness driver's turnState part (`readers/<harness>-turn-state.ts`). */
export function turnStateOf(provider: TurnProvider, input: TurnStateInput): TurnSnapshot {
    return harnessTurnState(provider).read(input);
}

/**
 * Every file `readTurnState` reads for this transcript: the transcript, and the provider's event log when it has
 * one. A caller that skips an unchanged session stats these, so a Grok permission prompt (written only to
 * `events.jsonl`) still counts as a change.
 */
export function turnStateSources(provider: TurnProvider, transcriptPath: string): string[] {
    const eventLog = resolveHistoryProvider(provider).reader.dialog.eventLogPath(transcriptPath);
    return eventLog ? [transcriptPath, eventLog] : [transcriptPath];
}

/** Every whole JSON line of a raw tail, with the byte offset where it starts. */
function tailRecords(tail: { raw: Buffer; start: number }): { records: JsonRecord[]; offsets: number[] } {
    const records: JsonRecord[] = [];
    const offsets: number[] = [];
    // Lines are cut from the raw bytes, so an offset stays exact past a line that holds invalid UTF-8.
    let from = 0;

    while (from <= tail.raw.length) {
        const newline = tail.raw.indexOf(0x0a, from);
        const end = newline === -1 ? tail.raw.length : newline;
        const record = parseTranscriptLine(tail.raw.subarray(from, end).toString("utf8"));

        if (record !== null) {
            records.push(record);
            offsets.push(tail.start + from);
        }

        from = end + 1;
    }

    return { records, offsets };
}

/** The provider's normalized open permission, or undefined when its event log is absent or unreadable. */
function readDialogPermission(provider: TurnProvider, transcriptPath: string): NativeDialogPermission | undefined {
    const dialog = resolveHistoryProvider(provider).reader.dialog;
    const path = dialog.eventLogPath(transcriptPath);

    if (!path || !existsSync(path)) {
        return undefined;
    }

    try {
        const tail = readTailAt(path, EVENT_LOG_TAIL_BYTES);
        if (tail.start > 0) {
            logger.debug(
                { path, cap: EVENT_LOG_TAIL_BYTES, skippedBytes: tail.start },
                "dialog event log tail omits older records"
            );
        }
        return dialog.openPermission(tailRecords(tail).records) ?? undefined;
    } catch (err) {
        logger.debug({ err, path, provider }, "[transcripts] could not read the session event log");
        return undefined;
    }
}

export interface ReadTurnStateOptions {
    now?: number;
    stallTimeoutMs: number;
}

/**
 * The turn state of one native transcript file, or null for a file that is empty or cannot be read.
 *
 * A last record longer than `TURN_TAIL_BYTES` leaves no whole record in the tail. The state then comes
 * from the modification time alone: `RUNNING` or `STALLED`, never a finish.
 *
 * A `.jsonl.zst` rollout is read from its decompressed content (offsets count decompressed bytes) and is closed
 * (`TurnStateInput.closed`): Codex compresses only a rollout it no longer writes.
 */
export function readTurnState(
    provider: TurnProvider,
    filePath: string,
    options: ReadTurnStateOptions
): TurnSnapshot | null {
    const now = options.now ?? Date.now();

    try {
        const stat = statSync(filePath);

        if (stat.size === 0) {
            return null;
        }

        const tail = readTailAt(filePath, TURN_TAIL_BYTES);
        const { records, offsets } = tailRecords(tail);
        const permission = readDialogPermission(provider, filePath);

        return {
            ...turnStateOf(provider, {
                records,
                offsets,
                ...(permission ? { permission } : {}),
                lastModified: stat.mtimeMs,
                now,
                stallTimeoutMs: options.stallTimeoutMs,
                ...(isZstdPath(filePath) ? { closed: true } : {}),
            }),
            tailStartOffset: tail.start,
        };
    } catch (err) {
        logger.debug({ err, filePath, provider }, "[transcripts] could not read the turn state of a transcript");
        return null;
    }
}
