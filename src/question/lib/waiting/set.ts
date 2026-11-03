import { type OpenQuestion, openQuestionKey } from "@genesiscz/utils/agents/dialogs/types";
import { awaitsAnswer, type DecisionRecord, kindOf } from "../decisions/store";
import type { AskForm } from "../pending/types";

/**
 * The waiting set: one pure answer to "what waits for the human". The banner, the stale check, the hub inbox, the
 * notch widget and the phone queue each asked this with their own predicate, and the predicates disagreed on `for`
 * (a decision for an agent raised the badge but no banner) and on an uncertain delivery. Each surface now asks the
 * rules here; a surface's own deliberate filter (blocking-only for the stale check, the widget's "Mark all read", a
 * decision-only badge) stays a filter on top, never a fifth rule.
 */

/**
 * How long a quiet session's open items keep counting as waiting. A decision left open in a session that ended ten
 * days ago is not news; it stays in that session's inbox, it just stops raising a badge. One rule for the widget's
 * badges, the hub's Inbox and the phone queue.
 */
export const INBOX_STALE_MS = 72 * 60 * 60 * 1000;

/**
 * Whether a session's waiting items count: the session worked, or asked the newest of them, within `INBOX_STALE_MS`.
 * Per session, so every waiting item of a counted session counts. The widget used to ask it per item by the row's
 * last update, so a stage on an old decision counted it again there and nowhere else.
 */
export function inboxSessionFresh({
    activityAt,
    newestAskAt,
    now,
}: {
    activityAt: number;
    newestAskAt: number;
    now: number;
}): boolean {
    return Math.max(activityAt, newestAskAt) >= now - INBOX_STALE_MS;
}

/**
 * Whether a posted row is addressed to the human. A decision is, unless it names someone else in `for` (an agent, or
 * a model like "fable"); a todo only when it says `for: "human"`, since most todos are the agent's own list.
 */
export function addressedToHuman(row: Pick<DecisionRecord, "for" | "type">): boolean {
    const target = row.for?.trim().toLowerCase();

    if (kindOf(row) === "decision") {
        return !target || target === "human";
    }

    return target === "human";
}

/**
 * Whether a stored row waits for the human now: it still awaits its answer (`open`, or `drafted` with an unsent
 * pick), it is addressed to the human, and no send of it ended uncertain (that answer may already be with the agent,
 * so it waits on a check, not on an answer).
 */
export function waitsOnHuman(row: Pick<DecisionRecord, "for" | "type" | "state" | "delivery">): boolean {
    return awaitsAnswer(row) && addressedToHuman(row) && !row.delivery?.uncertain;
}

export type WaitingKind = "decision" | "todo" | "form" | "dialog";

/** One thing that waits for the human. */
export interface WaitingItem {
    kind: WaitingKind;
    /** The item's own id: the decision row id, the form id, the dialog key. */
    key: string;
    /** The agent session it belongs to; null for a form no session posted. */
    session: string | null;
    /** When it was asked (epoch ms): a decision's newest revision, a form's post, a dialog's ask. */
    askedAt: number;
    /** The row's `blocking` flag (the stale check reads only these); forms and dialogs always block their agent. */
    blocking: boolean;
    /** The notice that stands for it (one banner per session): the session id, or the form id when it has none. */
    noticeGroup: string;
    /** It counts in the badges: its session is fresh (or live) and it was asked after the clear watermark. */
    counted: boolean;
}

export interface WaitingSession {
    /** The session id, or `form:<id>` for a form no session posted (as `noticeGroup`). */
    key: string;
    session: string | null;
    /** Every waiting item of the session. */
    waiting: number;
    /** The items that count in the badges. */
    counted: number;
    newestAskAt: number;
    /** `inboxSessionFresh` for the session, or it is live. */
    fresh: boolean;
}

export interface WaitingSet {
    /** Newest ask first. */
    items: WaitingItem[];
    /** Newest ask first. */
    sessions: WaitingSession[];
    /** The badge number: every counted item. */
    total: number;
}

/** The form fields the waiting set reads. */
export type WaitingForm = Pick<AskForm, "id" | "createdAt" | "status" | "sessionHint">;

/** The dialog fields the waiting set reads. */
export type WaitingDialog = Pick<OpenQuestion, "provider" | "sessionId" | "toolCallId" | "askedAt" | "closedAt">;

export interface WaitingInput {
    /** Stored decision and todo rows, in any state; the rules pick the waiting ones. */
    rows: readonly DecisionRecord[];
    forms?: readonly WaitingForm[];
    dialogs?: readonly WaitingDialog[];
    /** When a session last worked (epoch ms); 0 or absent when the caller does not know it. */
    activityAt?: (session: string) => number | undefined;
    /** Sessions with a running agent: their items count whatever their age. */
    live?: ReadonlySet<string>;
    /** The widget's "Mark all read": an item asked at or before it stays listed but stops counting. */
    clearedAt?: number;
    now?: number;
}

function timeOf(value: string | undefined): number {
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

/** When a row was asked: its newest revision, its post, or its last update for rows older than both fields. */
export function askedAtOf(row: Pick<DecisionRecord, "revisedTs" | "createdTs" | "updatedTs">): number {
    return timeOf(row.revisedTs ?? row.createdTs ?? row.updatedTs);
}

type Candidate = Omit<WaitingItem, "counted">;

function candidates({ rows, forms = [], dialogs = [] }: WaitingInput): Candidate[] {
    const found: Candidate[] = [];

    for (const row of rows) {
        if (!waitsOnHuman(row)) {
            continue;
        }

        const kind = kindOf(row);
        found.push({
            kind,
            key: row.id,
            session: row.sessionId,
            askedAt: askedAtOf(row),
            blocking: row.blocking === true,
            noticeGroup: row.sessionId,
        });
    }

    for (const form of forms) {
        if (form.status !== "pending") {
            continue;
        }

        const session = form.sessionHint ?? null;
        found.push({
            kind: "form",
            key: form.id,
            session,
            askedAt: form.createdAt,
            blocking: true,
            noticeGroup: session ?? `form:${form.id}`,
        });
    }

    for (const dialog of dialogs) {
        if (dialog.closedAt !== undefined) {
            continue;
        }

        found.push({
            kind: "dialog",
            key: openQuestionKey(dialog),
            session: dialog.sessionId,
            askedAt: timeOf(dialog.askedAt),
            blocking: true,
            noticeGroup: dialog.sessionId,
        });
    }

    return found;
}

/**
 * Everything that waits for the human, with the counts per session and the badge total. Pure over the rows a caller
 * already read; the caller keeps its own bound (the widget's SQL window) and its own filter on top.
 */
export function waitingSet(input: WaitingInput): WaitingSet {
    const now = input.now ?? Date.now();
    const clearedAt = input.clearedAt ?? 0;
    const found = candidates(input);
    const groups = new Map<string, Candidate[]>();

    for (const item of found) {
        const list = groups.get(item.noticeGroup) ?? [];
        list.push(item);
        groups.set(item.noticeGroup, list);
    }

    const items: WaitingItem[] = [];
    const sessions: WaitingSession[] = [];

    for (const [key, list] of groups) {
        const session = list[0].session;
        const newestAskAt = Math.max(...list.map((item) => item.askedAt));
        const fresh =
            (session !== null && input.live?.has(session) === true) ||
            inboxSessionFresh({ activityAt: (session && input.activityAt?.(session)) || 0, newestAskAt, now });
        let counted = 0;

        for (const item of list) {
            const counts = fresh && item.askedAt > clearedAt;
            counted += counts ? 1 : 0;
            items.push({ ...item, counted: counts });
        }

        sessions.push({ key, session, waiting: list.length, counted, newestAskAt, fresh });
    }

    items.sort((a, b) => b.askedAt - a.askedAt);
    sessions.sort((a, b) => b.newestAskAt - a.newestAskAt);

    return { items, sessions, total: sessions.reduce((sum, entry) => sum + entry.counted, 0) };
}
