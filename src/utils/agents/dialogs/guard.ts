import { readTurnState, type TurnSnapshot } from "@genesiscz/utils/ai/transcripts/turn-state";
import { logger } from "@genesiscz/utils/logger";
import { readSessionQuestionsStrict } from "./store";
import type { DialogProvider, OpenDialog, OpenQuestion } from "./types";

/** A turn that ended on a question waits for the user; past this the reader calls a silent turn stalled instead. */
const DIALOG_STALL_TIMEOUT_MS = 90_000;

/**
 * The newest open question of the session's dialog records, or null. The records come from the harness hooks and
 * the hub watcher (`store.ts`), so this costs one small file read and no transcript parse.
 */
export function dialogFromRecords(questions: readonly OpenQuestion[]): OpenDialog | null {
    const open = questions.find((question) => question.closedAt === undefined);

    if (!open) {
        return null;
    }

    return {
        kind: open.kind,
        question: open.question,
        toolCallId: open.toolCallId,
        ...(open.options ? { options: open.options } : {}),
        signal: open.source,
    };
}

/**
 * A dialog the transcript itself proves: the turn-state reader sets `asksQuestion` only when the session waits on a
 * question tool (Claude `AskUserQuestion`, Codex `request_user_input`, Grok `ask_user_question` or `exit_plan`),
 * decided from the tool calls and never from the wording. Permission prompts leave no transcript record, so only
 * the hook records (`dialogFromRecords`) can see those.
 */
export function dialogFromSnapshot(snapshot: TurnSnapshot | null): OpenDialog | null {
    if (!snapshot?.asksQuestion) {
        return null;
    }

    return {
        kind: snapshot.questionCall?.kind ?? "decision",
        question: snapshot.question,
        toolCallId: snapshot.questionCall?.callId,
        signal: "turn-state",
    };
}

export interface OpenDialogQuery {
    provider: DialogProvider;
    sessionId: string;
    /** The session's native transcript, when the caller has it; without it only the hook records are read. */
    transcriptPath?: string;
    /** The dialog records root, for tests. */
    recordsRoot?: string;
    now?: number;
}

/**
 * Is a dialog open in the session right now? State signals only, no screen read: the hook records first (they
 * cover permission prompts and plan approvals), then the transcript's turn state. On 2026-10-2x typed decision
 * answers landed inside an open `AskUserQuestion` dialog as free text; a caller that types into a pane asks this
 * first and refuses, or answers the dialog structurally, when it says yes (handoff h_ppczhri1).
 */
export function openDialogFor(query: OpenDialogQuery): OpenDialog | null {
    let recorded: OpenDialog | null;
    try {
        const questions = readSessionQuestionsStrict(query.provider, query.sessionId, query.recordsRoot)
            .filter((question) => question.closedAt === undefined)
            .sort((a, b) => b.askedAt.localeCompare(a.askedAt));
        recorded = dialogFromRecords(questions);
    } catch (error) {
        logger.warn(
            { error, sessionId: query.sessionId, provider: query.provider },
            "dialog records unreadable; blocking typed delivery"
        );
        return { kind: "decision", question: null, signal: "unreadable" };
    }

    if (recorded) {
        return recorded;
    }

    if (!query.transcriptPath) {
        return null;
    }

    return dialogFromSnapshot(
        readTurnState(query.provider, query.transcriptPath, { now: query.now, stallTimeoutMs: DIALOG_STALL_TIMEOUT_MS })
    );
}

/** The reason a typed delivery is refused while a dialog is open; the caller queues the text with it. */
export function dialogRefusal(dialog: OpenDialog): string {
    if (dialog.signal === "unreadable") {
        return "could not read the session's dialog records; typed delivery is blocked until they are repaired, or pass force to type anyway.";
    }
    const what =
        dialog.kind === "permission"
            ? "a permission prompt"
            : dialog.kind === "plan"
              ? "a plan approval"
              : "a question dialog";
    const question = dialog.question ? ` (${dialog.question.slice(0, 160)})` : "";

    return `${what} is open in the session${question}; free text would land in the dialog instead of the prompt. Answer the dialog first, or pass force to type anyway.`;
}
