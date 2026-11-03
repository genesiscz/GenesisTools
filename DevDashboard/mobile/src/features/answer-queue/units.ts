import type { DecisionSendDto, WaitingDecisionDto, WaitingFormDto, WaitingSessionDto } from "@dd/contract";

/**
 * Pure rules of the answer queue (F6): what a send's answer means for the user, what a session has staged, and
 * whether a form is complete. No React, no client, so they test without a renderer.
 */

/** The three outcomes a send shows: it reached the agent, it waits for the agent's next turn, or nobody knows. */
export type ReceiptKind = "delivered" | "queued" | "uncertain";

export interface Receipt {
    kind: ReceiptKind;
    /** Where it went (`cmux · pane 1`) or why it is queued; never a raw error dump. */
    detail: string | null;
}

/**
 * The receipt of a send of staged picks. An uncertain send may already be with the agent, so it is never shown as
 * delivered or as queued; an undelivered certain send stays stored as answered and rides the next prompt (queued).
 */
export function receiptOf(send: DecisionSendDto): Receipt {
    if (send.uncertain) {
        return { kind: "uncertain", detail: send.target ?? send.error ?? null };
    }

    if (send.delivered) {
        return { kind: "delivered", detail: send.target ?? send.channel ?? null };
    }

    return { kind: "queued", detail: send.error ?? null };
}

/**
 * A receipt kept above the queue. A sent session or an answered form leaves the queue on the next read, and its card
 * with it, so the receipt lives here until the user dismisses it; an uncertain send is never lost unread.
 */
export interface RecentReceipt {
    /** The receipt line's test id, one per card (`answer-queue-session-<key>-receipt`). */
    testID: string;
    /** What was sent: the session title, or the form. */
    label: string;
    receipt: Receipt;
}

/** How many recent receipts the queue keeps; the oldest goes first. */
export const RECENT_RECEIPTS_MAX = 5;

/** Newest first; a newer receipt of the same card replaces its older one. */
export function withRecentReceipt(list: readonly RecentReceipt[], entry: RecentReceipt): RecentReceipt[] {
    return [entry, ...list.filter((kept) => kept.testID !== entry.testID)].slice(0, RECENT_RECEIPTS_MAX);
}

export const RECEIPT_LABEL: Record<ReceiptKind, string> = {
    delivered: "Delivered",
    queued: "Queued for the next turn",
    uncertain: "Uncertain: check the session",
};

/**
 * A key that makes a write safe to retry: the Mac answers a repeat with the first answer. Made once per user
 * action and passed in the mutation's variables, so a retry of the same action sends the same key.
 */
export function idempotencyKey(): string {
    return `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function decisionsOf(session: WaitingSessionDto): WaitingDecisionDto[] {
    return session.items.filter((item): item is WaitingDecisionDto => item.kind === "decision");
}

/** The decisions of a session with a staged pick or note: what one send delivers as one message. */
export function stagedOf(session: WaitingSessionDto): WaitingDecisionDto[] {
    return decisionsOf(session).filter((item) => Boolean(item.draftOption) || Boolean(item.draft?.trim()));
}

/** One answer per question of a form, as the user filled it. */
export interface FormDraft {
    [itemId: string]: { selected: string[]; text: string };
}

/** The questions a form still needs before it may be sent: required ones with no pick and no text. */
export function missingAnswers(form: WaitingFormDto, draft: FormDraft): string[] {
    return form.questions
        .filter((question) => {
            const answer = draft[question.itemId];
            return question.required && !answer?.selected.length && !answer?.text.trim();
        })
        .map((question) => question.itemId);
}

/** The body of a form answer: the picks by choice id and the typed text, questions with nothing left out. */
export function formAnswers(form: WaitingFormDto, draft: FormDraft) {
    return form.questions.flatMap((question) => {
        const answer = draft[question.itemId];

        if (!answer || (answer.selected.length === 0 && !answer.text.trim())) {
            return [];
        }

        return [
            {
                itemId: question.itemId,
                ...(answer.selected.length > 0 ? { selectedChoices: answer.selected } : {}),
                ...(answer.text.trim() ? { freeText: answer.text.trim() } : {}),
            },
        ];
    });
}

/** A pick on a question: one choice replaces the last unless the question takes several. */
export function togglePick(selected: string[], choice: string, multiple: boolean): string[] {
    if (selected.includes(choice)) {
        return selected.filter((entry) => entry !== choice);
    }

    return multiple ? [...selected, choice] : [choice];
}
