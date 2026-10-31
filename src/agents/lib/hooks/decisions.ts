import { createHash } from "node:crypto";
import {
    type ChatAnswerState,
    type DecisionHookDeps,
    type DecisionHookPayload,
    finalReply as finalReplyWith,
    type NudgeState,
    type PromptHookOutput,
    type ReadSession,
    runDecisionInject as runDecisionInjectWith,
    runDecisionStop as runDecisionStopWith,
    type StopBlockCounts,
    type StopHookOutput,
} from "@app/question/lib/decisions/hook";
import type { DecisionsHookConfig } from "@app/question/lib/decisions/hook-config";
import { appendChatAnswerRun } from "./chat-answer-log";
import { hookDiag } from "./log";
import { bumpContextCounts, readContextCounts, setContextValues, updateContextCounts } from "./state";

/**
 * The agents hooks' wiring of the decision hooks, which live beside the decision log
 * (`src/question/lib/decisions/hook.ts`): the per-session state in `hooks-state/<session>.json`, the diagnostic log
 * and the chat-answer run log. The key names below are what that state file holds on disk.
 */

/** The per-session counter the loop guard reads; it lives beside the guard's context counts. */
export const STOP_BLOCK_COUNTER = "decisions-stop-block";
/** The question nudge's own block counter, so it and the `❓ DECISION N` check do not spend each other's budget. */
export const NUDGE_BLOCK_COUNTER = "decisions-nudge-block";
/** The provider's stable key for the last turn the question nudge spoke in. */
export const NUDGE_TURN_KEY = "decisions-nudge-turn";

/** When the chat-answer step last read the session to its end (epoch ms), together with `CHAT_OFFSET_PREFIX`. */
export const CHAT_CHECKED_KEY = "decisions-chat-checked";
/**
 * Prefix (plus a hash of the transcript path) of the byte offset the chat-answer step last read up to. The next read
 * starts there, so each row is read once, however far the oldest open ask is: a time bound with an 8 MB cap never
 * reached answers 229 MB back in a 447 MB transcript and read the same 8 MB on every Stop (2026-10-27).
 */
export const CHAT_OFFSET_PREFIX = "decisions-chat-offset:";
/** Prefix of the per-decision mark that the chat-answer step already sent the agent back about it. */
export const CHAT_SENT_BACK_PREFIX = "decisions-chat-sent-back:";
const fileCounts: StopBlockCounts = {
    read: (session: string) => readContextCounts(session)[STOP_BLOCK_COUNTER] ?? 0,
    bump: (session: string) => bumpContextCounts(session, [STOP_BLOCK_COUNTER]),
};

const fileNudgeState: NudgeState = {
    blocks: (session) => readContextCounts(session)[NUDGE_BLOCK_COUNTER] ?? 0,
    lastTurn: (session) => readContextCounts(session)[NUDGE_TURN_KEY],
    record: (session, turn, blocked) =>
        updateContextCounts(session, (counts) => {
            const blocks = counts[NUDGE_BLOCK_COUNTER] ?? 0;
            return { ...counts, [NUDGE_TURN_KEY]: turn, [NUDGE_BLOCK_COUNTER]: blocked ? blocks + 1 : blocks };
        }),
};

function offsetKey(transcript: string): string {
    return `${CHAT_OFFSET_PREFIX}${createHash("sha1").update(transcript).digest("hex").slice(0, 16)}`;
}

const fileChatState: ChatAnswerState = {
    checkedAt: (session) => readContextCounts(session)[CHAT_CHECKED_KEY],
    setCheckedAt: (session, at) => setContextValues(session, { [CHAT_CHECKED_KEY]: at }),
    offset: (session, transcript) => readContextCounts(session)[offsetKey(transcript)],
    setOffset: (session, transcript, offset) => setContextValues(session, { [offsetKey(transcript)]: offset }),
    sentBack: (session, id) => readContextCounts(session)[`${CHAT_SENT_BACK_PREFIX}${id}`] !== undefined,
    markSentBack: (session, ids) =>
        setContextValues(session, Object.fromEntries(ids.map((id) => [`${CHAT_SENT_BACK_PREFIX}${id}`, 1]))),
};

/** The stores a deps value leaves out are the file-backed ones; tests pass in-memory ones. */
export type AgentDecisionHookDeps = Omit<DecisionHookDeps, "diag" | "chat" | "counts" | "nudge" | "appendRun"> &
    Partial<Pick<DecisionHookDeps, "diag" | "chat" | "counts" | "nudge" | "appendRun">>;

function wired(deps: AgentDecisionHookDeps): DecisionHookDeps {
    return {
        ...deps,
        diag: deps.diag ?? hookDiag,
        chat: deps.chat ?? fileChatState,
        counts: deps.counts ?? fileCounts,
        nudge: deps.nudge ?? fileNudgeState,
        appendRun: deps.appendRun ?? ((run) => appendChatAnswerRun(run)),
    };
}

export function runDecisionStop(
    payload: DecisionHookPayload,
    config: DecisionsHookConfig,
    deps: AgentDecisionHookDeps
): Promise<StopHookOutput | null> {
    return runDecisionStopWith(payload, config, wired(deps));
}

export function runDecisionInject(
    payload: DecisionHookPayload,
    config: DecisionsHookConfig,
    deps: AgentDecisionHookDeps & { emit: (output: PromptHookOutput) => unknown }
): Promise<PromptHookOutput | null> {
    return runDecisionInjectWith(payload, config, { ...wired(deps), emit: deps.emit });
}

export function finalReply(payload: DecisionHookPayload, read: ReadSession | undefined): Promise<string> {
    return finalReplyWith(payload, read, hookDiag);
}

export type { ChatAnswerState, NudgeState, PromptHookOutput, ReadSession, StopHookOutput };
