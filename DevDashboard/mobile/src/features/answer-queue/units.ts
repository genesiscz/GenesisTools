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

/** The note a decision card edits, and the server draft and revision it was written against. */
export interface NoteState {
    note: string;
    base: { revision: number; draft: string };
}

export function noteStateOf(decision: Pick<WaitingDecisionDto, "revision" | "draft">): NoteState {
    const draft = decision.draft ?? "";
    return { note: draft, base: { revision: decision.revision, draft } };
}

/** The user changed the note since the draft it was written against. */
export function noteIsDirty(state: NoteState): boolean {
    return state.note.trim() !== state.base.draft.trim();
}

/**
 * A poll brought a new draft or revision. An untouched note follows the server. A changed note keeps its text AND its
 * old base, so its stage carries the revision it was written on and a re-posted decision refuses it with the Mac's
 * words, instead of staging an old note against the new text.
 */
export function reconcileNote(state: NoteState, incoming: Pick<WaitingDecisionDto, "revision" | "draft">): NoteState {
    const draft = incoming.draft ?? "";

    if (state.base.revision === incoming.revision && state.base.draft === draft) {
        return state;
    }

    return noteIsDirty(state) ? state : { note: draft, base: { revision: incoming.revision, draft } };
}

/**
 * Send waits for every card to save what it holds (a note still being typed, a stage still in flight); one that fails
 * stops the send, so a pick never goes out without the note the user just wrote. Returns whether it sent.
 */
export async function flushThenSend(flushes: Iterable<() => Promise<void>>, send: () => void): Promise<boolean> {
    try {
        await Promise.all([...flushes].map((flush) => flush()));
    } catch {
        return false;
    }

    send();
    return true;
}

/**
 * One run at a time: a second call while the first still runs does nothing and answers false. Send uses it, because
 * its flush runs before the mutation starts, so the mutation's own pending flag cannot block a second tap.
 */
export function singleFlight(): (run: () => Promise<unknown>) => Promise<boolean> {
    let busy = false;

    return async (run) => {
        if (busy) {
            return false;
        }

        busy = true;

        try {
            await run();
            return true;
        } finally {
            busy = false;
        }
    };
}

/**
 * The card's latest stage write. `settled()` waits for it and rejects when it failed: a refused pick must stop the
 * session's Send, or the pick staged before it would go out as if nothing happened. `refusal()` is that failure's
 * error, for the card to show: the tracker outlives a remounted card, whose fresh mutation has no error to show. A
 * later successful stage clears both.
 */
export function latestStage(): {
    track: (write: Promise<unknown>) => void;
    settled: () => Promise<void>;
    refusal: () => unknown;
} {
    let latest: Promise<unknown> | null = null;
    let refused: unknown = null;

    return {
        track(write) {
            latest = write;
            write.then(
                () => {
                    if (latest === write) {
                        latest = null;
                        refused = null;
                    }
                },
                (error: unknown) => {
                    if (latest === write) {
                        refused = error;
                    }
                }
            );
        },
        async settled() {
            if (latest) {
                await latest;
            }
        },
        refusal: () => refused,
    };
}

type StageTracker = ReturnType<typeof latestStage>;

/**
 * A decision card's flush before Send. A failed pick blocks until a later pick succeeds (the pick before it must not
 * go out in its place). A failed note save never blocks by itself: the note is still dirty, so `saveNote` tries it
 * again here, and only that retry's failure stops the send.
 */
export async function flushDecision({
    pick,
    note,
    saveNote,
}: {
    pick: StageTracker;
    note: StageTracker;
    saveNote: () => Promise<void>;
}): Promise<void> {
    await pick.settled();
    await note.settled().catch(() => undefined);
    await saveNote();
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

/**
 * The decisions a session card shows, each at the revision it shows: a send passes them, so the Mac sends exactly
 * these drafts. A draft staged on another surface for a decision the queue hides stays staged.
 */
export function shownDrafts(session: WaitingSessionDto): { number: number; expectedRevision: number }[] {
    return decisionsOf(session).map((item) => ({ number: item.number, expectedRevision: item.revision }));
}

/** One answer per question of a form, as the user filled it. */
export interface FormDraft {
    [itemId: string]: { selected: string[]; text: string };
}

/** A session card's key in the list: the session, else its first item (a form no session posted). */
export function queueSessionKey(session: WaitingSessionDto): string {
    return session.sessionId ?? session.items[0]?.id ?? "form";
}

/**
 * The edits the cards hold before they reach the Mac (a note being typed, a form being filled), and each decision's
 * stage trackers, by item id. The queue is a virtualized list, so a card that scrolls far away unmounts; what it held
 * lives here and the remount reads it back.
 */
export interface KeptEdits {
    notes: Map<string, NoteState>;
    forms: Map<string, FormDraft>;
    stages: Map<string, DecisionStages>;
}

/**
 * A decision card's pick and note trackers (`latestStage`). Kept with the edits: a refused pick must keep Send blocked
 * after the card remounts, or the pick staged before it goes out alone.
 */
export interface DecisionStages {
    pick: StageTracker;
    note: StageTracker;
}

export function keptEdits(): KeptEdits {
    return { notes: new Map(), forms: new Map(), stages: new Map() };
}

/** The kept stage trackers of a decision, made on first use and kept until its item leaves the queue. */
export function stagesOf(kept: KeptEdits, key: string): DecisionStages {
    const found = kept.stages.get(key);

    if (found) {
        return found;
    }

    const made = { pick: latestStage(), note: latestStage() };
    kept.stages.set(key, made);
    return made;
}

/** The kept edit for `key`, or `init()` when the card has none yet. */
export function keptOr<T>(map: Map<string, T>, key: string, init: () => T): T {
    return map.has(key) ? (map.get(key) ?? init()) : init();
}

/** Drops the edits of items no longer in the queue (sent, answered, dismissed), so the store holds only live cards. */
export function pruneKept(kept: KeptEdits, sessions: readonly WaitingSessionDto[]): void {
    const live = new Set(sessions.flatMap((session) => session.items.map((item) => item.id)));

    for (const map of [kept.notes, kept.forms, kept.stages]) {
        for (const key of [...map.keys()]) {
            if (!live.has(key)) {
                map.delete(key);
            }
        }
    }
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
export function togglePick({
    selected,
    choice,
    multiple,
}: {
    selected: string[];
    choice: string;
    multiple: boolean;
}): string[] {
    if (selected.includes(choice)) {
        return selected.filter((entry) => entry !== choice);
    }

    return multiple ? [...selected, choice] : [choice];
}
