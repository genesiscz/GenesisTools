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
import { readHookState, updateHookState } from "./state";

/**
 * The agents hooks' wiring of the decision hooks, which live beside the decision log
 * (`src/question/lib/decisions/hook.ts`): the per-session state in `hooks-state/<session>.json`, the diagnostic log
 * and the chat-answer run log. The state's shape is `DecisionSessionState` in `./state`.
 */

const fileCounts: StopBlockCounts = {
    read: (session) => readHookState(session).decisions.stopBlocks,
    bump: (session) =>
        updateHookState(session, (state) => {
            state.decisions.stopBlocks += 1;
        }),
};

const fileNudgeState: NudgeState = {
    blocks: (session) => readHookState(session).decisions.nudge.blocks,
    lastTurn: (session) => readHookState(session).decisions.nudge.lastTurn,
    record: (session, turn, blocked) =>
        updateHookState(session, (state) => {
            state.decisions.nudge = { blocks: state.decisions.nudge.blocks + (blocked ? 1 : 0), lastTurn: turn };
        }),
};

/** A transcript's key in `chat.offsets`: a short hash of its path. */
function transcriptKey(transcript: string): string {
    return createHash("sha1").update(transcript).digest("hex").slice(0, 16);
}

const fileChatState: ChatAnswerState = {
    checkedAt: (session) => readHookState(session).decisions.chat.checkedAt,
    setCheckedAt: (session, at) =>
        updateHookState(session, (state) => {
            state.decisions.chat.checkedAt = at;
        }),
    offset: (session, transcript) => readHookState(session).decisions.chat.offsets[transcriptKey(transcript)],
    setOffset: (session, transcript, offset) =>
        updateHookState(session, (state) => {
            state.decisions.chat.offsets[transcriptKey(transcript)] = offset;
        }),
    sentBack: (session, id) => readHookState(session).decisions.chat.sentBack.includes(id),
    markSentBack: (session, ids) =>
        updateHookState(session, (state) => {
            const sent = state.decisions.chat.sentBack;
            sent.push(...ids.filter((id) => !sent.includes(id)));
        }),
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
