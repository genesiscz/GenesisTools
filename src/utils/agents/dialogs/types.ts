/** The harnesses a dialog record can belong to; the same spellings as `TurnProvider`. */
export type DialogProvider = "claude" | "codex" | "grok";

/** What the agent waits on: a question with options, a permission prompt, or a plan to approve. */
export type OpenQuestionKind = "decision" | "permission" | "plan";

/** Which signal wrote the record: a harness hook, the hub-side watcher, or a turn-state read of the transcript. */
export type OpenQuestionSource = "hook" | "watcher" | "turn-state";

/**
 * A structural question an agent asked its user and still waits on: Claude's `AskUserQuestion`, `ExitPlanMode`
 * and permission prompts, Codex `request_user_input` (sync and async), Grok `ask_user_question`, `exit_plan` and
 * the permission prompts of its `events.jsonl`.
 *
 * One identity everywhere, `provider:sessionId:toolCallId` (`openQuestionKey`), so a hook and a watcher never
 * post the same question twice, and the hub inbox, the widget and the answer-delivery guard all see one item
 * (handoffs h_bgj1m68y, h_b19qtqux, h_ppczhri1).
 */
export interface OpenQuestion {
    provider: DialogProvider;
    sessionId: string;
    /** The tool call or request id that asked; the key's third part. */
    toolCallId: string;
    kind: OpenQuestionKind;
    question: string;
    options?: string[];
    /** ISO time the question was asked. */
    askedAt: string;
    /** ISO time it was answered or withdrawn; absent while it is open. */
    closedAt?: string;
    source: OpenQuestionSource;
}

export function openQuestionKey(question: Pick<OpenQuestion, "provider" | "sessionId" | "toolCallId">): string {
    return `${question.provider}:${question.sessionId}:${question.toolCallId}`;
}

/** What the answer-delivery guard needs to know about a dialog that is open right now. */
export interface OpenDialog {
    kind: OpenQuestionKind;
    question: string | null;
    toolCallId?: string;
    options?: string[];
    signal: OpenQuestionSource;
}
