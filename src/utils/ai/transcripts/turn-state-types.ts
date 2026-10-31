/**
 * The shapes of a turn-state read: what a harness dialect gets (`TurnStateInput`) and returns (`TurnSnapshot`).
 * Type-only and import-free of the readers, so a dialect (`readers/<harness>-turn-state.ts`), the shared helpers
 * (`turn-state-core.ts`) and the driver contracts (`harness/parts.ts`) can name them without importing the disk read
 * in `turn-state.ts`, which loads the drivers.
 */
import type { NativeDialogPermission } from "@genesiscz/utils/agent-sessions/types";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import type { ActivityState } from "./activity";

export type TurnProvider = AccountProviderAlias;

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
    /**
     * Set by the dialect when the call stops the turn until the user answers it (Claude's question and plan tools):
     * the live phase is then `waiting`, not `tool`. Grok and Codex questions arrive as `TurnSnapshot.asksQuestion`.
     */
    waits?: Exclude<TurnQuestionKind, "permission">;
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
    /**
     * True when the newest turn in the tail has ended: a finish, an interrupt, or a question it waits on. False while
     * it runs, and when the tail holds no turn record at all.
     */
    turnEnded: boolean;
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
