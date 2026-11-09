import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import type { AgentIdentity } from "@genesiscz/utils/agent/identity";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import { appendCorrections, type Correction, correctionSchema } from "@genesiscz/utils/meetings/corrections";
import {
    type DecisionActor,
    decisionActorSchema,
    type MeetingChange,
    type MeetingItem,
    type MeetingRecord,
    type MeetingStore,
    meetingItemSchema,
} from "@genesiscz/utils/meetings/record";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { z } from "zod";
import { ANSWER_LOG_FILE, type AnswerEvent, appendAnswerEvent } from "./answer-log";
import {
    answerQuestion,
    DEFAULT_LISTEN_BELOW,
    inputNeeded,
    openQuestions,
    type QuestionItem,
    questionIdOf,
    questionLabel,
    settleLookAlikes,
    skipQuestion,
    splitQuestion,
} from "./questions";
import { TOOL } from "./shared";
import { decisionLedger, ledgerEntryFor } from "./transcript-corrections";

const { log } = logger.scoped("meetings-journal");

/** The file in a meeting's folder that keeps its decision journal: one entry per line, oldest first, append-only. */
export const JOURNAL_FILE = "decisions.ndjson";

const itemRef = z.string().min(1);

/** One decision a person, an agent or a rule makes on a meeting. Item references take an id (`i42`) or `Q12`. */
const DECISION_ACTION_OPTIONS = [
    z.object({
        kind: z.literal("confirm"),
        items: z.array(itemRef),
        /** Every suggested item at or above this confidence instead of `items`. */
        minConfidence: z.number().optional(),
        /** Whose voice a speaker range is. */
        speaker: z.string().optional(),
        /** A term's right spelling, when the proposal is wrong. */
        proposed: z.string().optional(),
    }),
    z.object({ kind: z.literal("reject"), items: z.array(itemRef), minConfidence: z.number().optional() }),
    /** The item's value edited in place (a term's spelling, a range's speaker, a join's word): it is confirmed so. */
    z.object({ kind: z.literal("respell"), item: itemRef, text: z.string() }),
    z.object({ kind: z.literal("answer"), question: itemRef, answer: z.string(), comment: z.string().optional() }),
    z.object({ kind: z.literal("skip"), question: itemRef }),
    /** "Several voices": the question is cut into one question per line and voice. */
    z.object({ kind: z.literal("split"), question: itemRef }),
    /** A diarization label renamed for this meeting; the label's own name removes the rename. */
    z.object({ kind: z.literal("rename"), label: z.string().min(1), name: z.string() }),
    /** Items back to suggested, each to the state before its own last decision. */
    z.object({ kind: z.literal("reopen"), items: z.array(itemRef).min(1) }),
] as const;

export const decisionActionSchema = z.discriminatedUnion("kind", [...DECISION_ACTION_OPTIONS]);
export type DecisionAction = z.infer<typeof decisionActionSchema>;

/** The Undo of one entry (`items`: only these of its items; a question named brings back its whole answer). */
const revertActionSchema = z.object({
    kind: z.literal("revert"),
    token: z.string().min(1),
    items: z.array(itemRef).optional(),
});

const journalActionSchema = z.discriminatedUnion("kind", [...DECISION_ACTION_OPTIONS, revertActionSchema]);
type JournalAction = z.infer<typeof journalActionSchema>;
type JournalActionKind = JournalAction["kind"];
type ActionOf<K extends JournalActionKind> = Extract<JournalAction, { kind: K }>;

/** One item a decision changed: its state before (absent: the decision made it) and after (absent: it removed it). */
const itemChangeSchema = z.object({
    id: z.string(),
    before: meetingItemSchema.optional(),
    after: meetingItemSchema.optional(),
});
export type ItemChange = z.infer<typeof itemChangeSchema>;

/** A speaker label's name before and after (absent: the source's own label). */
const labelChangeSchema = z.object({ label: z.string(), before: z.string().optional(), after: z.string().optional() });
export type LabelChange = z.infer<typeof labelChangeSchema>;

export const SKIP_NEEDS = ["speaker", "proposed", "listen", "nothing"] as const;

/**
 * An item a decision named and left, with the reason. `needs`: what decides it, a `speaker` or `proposed` value, or an
 * answer by ear (`listen`); `nothing` when it is decided that way already, which is no failure.
 */
const skipSchema = z.object({ id: z.string(), reason: z.string(), needs: z.enum(SKIP_NEEDS).optional() });
export type DecisionSkip = z.infer<typeof skipSchema>;

/**
 * One line of the journal: who decided what on a meeting, when and why, and everything it changed, so its token
 * undoes exactly it. `decided`: the items it decided (their status or decision time changed); `settled`: the
 * look-alike questions an answer settled; `corrections`: the ledger lines it wrote.
 */
export const journalEntrySchema = z.object({
    token: z.string().min(1),
    at: z.string().min(1),
    meeting: z.string().min(1),
    actor: decisionActorSchema,
    reason: z.string().optional(),
    action: journalActionSchema,
    /** The question it decided (an answer, a skip, a split) or gave back (the Undo of one). */
    question: z.string().optional(),
    decided: z.array(z.string()).default([]),
    settled: z.array(z.string()).default([]),
    skipped: z.array(skipSchema).default([]),
    changes: z.array(itemChangeSchema).default([]),
    labels: z.array(labelChangeSchema).default([]),
    corrections: z.array(correctionSchema).default([]),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

/** An entry as `read` lists it: `revertedBy` names the later entry that gave back every item it decided. */
export type JournalReadEntry = JournalEntry & { revertedBy?: string };

/** What a decision did: its saved entry, or none when it changed nothing; and what it left, with the reason. */
export interface Decided {
    entry?: JournalEntry;
    skipped: DecisionSkip[];
}

export type MicShare = (fromSec: number, toSec: number) => number | undefined;

/** What "Several voices" needs to cut a question: the transcript, and the microphone's share when it is known. */
export interface SplitInputs {
    transcript(record: MeetingRecord): Promise<TranscriptEntry[]>;
    micShare?(record: MeetingRecord): Promise<MicShare | undefined>;
}

export interface DecisionRequest {
    meeting: string;
    action: DecisionAction;
    actor: DecisionActor;
    reason?: string;
}

export interface RevertRequest {
    meeting: string;
    /** The token of the entry to undo: `Decided.entry.token`, `confirm --json`'s token, an item's `decision.token`. */
    token: string;
    /** Only these of its items (ids or `Q12`); all of them when absent. */
    items?: string[];
    actor: DecisionActor;
    reason?: string;
}

export interface DecisionJournalOptions {
    store: MeetingStore;
    /** An answer settles look-alikes that reach this confidence (`global.suggest.listenBelow`). */
    listenBelow?: number;
    /** Where the corrections a decision confirms or withdraws go; the corrections ledger by default. */
    ledger?: (corrections: Correction[]) => void;
    /** The transcript and microphone share a split needs. */
    split?: SplitInputs;
    now?: () => Date;
}

/** What one action did to the record, besides the item and label changes the journal measures itself. */
interface ActionOutcome {
    history: MeetingChange;
    skipped?: DecisionSkip[];
    settled?: string[];
    corrections?: Correction[];
    /** The question this decision was about (answer, skip, split): the items it decided name it. */
    question?: string;
    /** False for an action that puts items back (reopen, revert): it stamps no decision on them. */
    stamps: boolean;
}

/** Read before the record's lock, for the actions that need more than the record (a split's transcript). */
interface Prepared {
    transcript?: TranscriptEntry[];
    micShare?: MicShare;
}

interface ActionContext {
    now: string;
    listenBelow: number;
    prepared: Prepared;
    /** A saved entry of this meeting by its token, for reopen and revert. */
    entryOf(token: string | undefined): JournalEntry | undefined;
}

interface ActionHandler<K extends JournalActionKind> {
    prepare?(record: MeetingRecord, action: ActionOf<K>, inputs: SplitInputs | undefined): Promise<Prepared>;
    /** Mutates `record`; returns what it did, or `skipped` alone when it changed nothing. */
    mutate(record: MeetingRecord, action: ActionOf<K>, context: ActionContext): ActionOutcome;
}

/** The value as it is stored: a key set to undefined is no key, since the record is written as JSON. */
function stored(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stored);
    }

    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, entry]) => entry !== undefined)
                .map(([key, entry]) => [key, stored(entry)])
        );
    }

    return value;
}

function same(a: unknown, b: unknown): boolean {
    return isDeepStrictEqual(stored(a), stored(b));
}

/** The items `after` differs from `before` in, each with both states; an item gone from `after` has no `after`. */
export function itemChanges(before: MeetingItem[], after: MeetingItem[]): ItemChange[] {
    const old = new Map(before.map((item) => [item.id, item]));
    const kept = new Set(after.map((item) => item.id));
    const changed = after.flatMap((item) => {
        const was = old.get(item.id);

        if (was && same(was, item)) {
            return [];
        }

        return [{ id: item.id, ...(was ? { before: was } : {}), after: structuredClone(item) }];
    });
    const removed = before.filter((item) => !kept.has(item.id)).map((item) => ({ id: item.id, before: item }));
    return [...changed, ...removed];
}

function revertFields(item: MeetingItem, before: MeetingItem, after: MeetingItem | undefined): MeetingItem {
    const next: Record<string, unknown> = { ...item };
    const was: Record<string, unknown> = before;
    const changed: Record<string, unknown> = after ?? {};

    for (const key of new Set([...Object.keys(was), ...Object.keys(changed)])) {
        // A field someone changed since keeps its newer value.
        if (!same(next[key], changed[key])) {
            continue;
        }

        if (was[key] === undefined) {
            delete next[key];
        } else {
            next[key] = was[key];
        }
    }

    return meetingItemSchema.parse(next);
}

/**
 * The inverse of `changes`: each field a decision set goes back to its value before, an item it made goes away (unless
 * changed since), and an item it removed comes back. Items and fields changed by anyone else since (an `items add`
 * during a round) stay as they are.
 */
export function revertChanges(items: MeetingItem[], changes: ItemChange[]): MeetingItem[] {
    const byId = new Map(changes.map((change) => [change.id, change]));
    const kept = items.flatMap((item) => {
        const change = byId.get(item.id);

        if (!change) {
            return [item];
        }

        if (!change.before) {
            return same(item, change.after) ? [] : [item];
        }

        return [revertFields(item, change.before, change.after)];
    });
    const present = new Set(items.map((item) => item.id));
    const restored = changes.flatMap((change) =>
        !change.after && change.before && !present.has(change.id) ? [change.before] : []
    );
    return [...kept, ...restored];
}

/** The item id a reference names: `Q12` is the record's twelfth question, anything else is the id itself. */
export function itemIdOf(record: MeetingRecord, ref: string): string {
    return /^q\d+$/i.test(ref.trim()) ? questionIdOf(record, ref) : ref;
}

/** Picks the items a decision names: ids, or every suggested item at or above a confidence. */
function pickItems(record: MeetingRecord, ids: string[], minConfidence?: number): MeetingItem[] {
    if (minConfidence !== undefined) {
        return record.items.filter((item) => item.status === "suggested" && (item.confidence ?? 0) >= minConfidence);
    }

    const missing = ids.filter((id) => !record.items.some((item) => item.id === id));

    if (missing.length > 0) {
        throw new Error(`${record.id} has no item ${missing.join(", ")} (${TOOL} items ${record.id})`);
    }

    return record.items.filter((item) => ids.includes(item.id));
}

/** The open question a reference names, or a skip that says why it is not one. */
function openQuestion(record: MeetingRecord, ref: string): { question?: QuestionItem; skip?: DecisionSkip } {
    const id = itemIdOf(record, ref);
    const item = record.items.find((one) => one.id === id);

    if (item?.kind !== "question") {
        throw new Error(`${record.id} has no question ${ref} (${TOOL} items ${record.id} --kind question)`);
    }

    const question = openQuestions(record).find((open) => open.id === id);
    return question
        ? { question }
        : { skip: { id, reason: `${questionLabel(record, id)} is ${item.status} already`, needs: "nothing" } };
}

/** A confirm or a reject of items, the CLI's `confirm` and `reject`. */
function decideItems(
    record: MeetingRecord,
    status: "confirmed" | "rejected",
    action: { items: string[]; minConfidence?: number; speaker?: string; proposed?: string },
    now: string
): ActionOutcome {
    const { minConfidence, speaker, proposed } = action;

    if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) {
        throw new Error(`minConfidence ${minConfidence} must be between 0 and 1 (0.8 = 80 %)`);
    }

    if (action.items.length === 0 && minConfidence === undefined) {
        throw new Error("Name the items (i1 i2 …) or give a minimum confidence (0..1)");
    }

    const picked = pickItems(
        record,
        action.items.map((ref) => itemIdOf(record, ref)),
        minConfidence
    );
    const skipped: DecisionSkip[] = [];

    // Deciding an item the same way again changes nothing, so it mints no token that would void the first Undo (MC16).
    for (const item of picked) {
        const changes =
            status === "confirmed" &&
            ((item.kind === "speaker-range" && speaker !== undefined && speaker !== item.speaker) ||
                (item.kind === "term" && proposed !== undefined && proposed !== item.proposed));

        if (item.status === status && !changes) {
            skipped.push({ id: item.id, reason: `it is ${status} already`, needs: "nothing" });
        }
    }

    if (status === "confirmed") {
        for (const item of picked.filter((one) => !skipped.some((skip) => skip.id === one.id))) {
            if (item.kind === "question") {
                const label = questionLabel(record, item.id);
                skipped.push({
                    id: item.id,
                    reason: `${label} is a question; answer it by ear: ${TOOL} listen ${record.id} --item ${label}`,
                    needs: "listen",
                });
            } else if (item.kind === "speaker-range" && inputNeeded(item) === "speaker" && !speaker) {
                const candidates = item.candidates?.length ? ` Candidates: ${item.candidates.join(", ")}.` : "";
                skipped.push({ id: item.id, reason: `it has no speaker yet.${candidates}`, needs: "speaker" });
            } else if (item.kind === "term" && inputNeeded(item) === "proposed" && !proposed) {
                skipped.push({ id: item.id, reason: `"${item.heard}" has no spelling yet.`, needs: "proposed" });
            }
        }
    }

    const deciding = picked.filter((item) => !skipped.some((skip) => skip.id === item.id));
    const corrections: Correction[] = [];

    for (const item of deciding) {
        const prior = ledgerEntryFor(record, item, now);
        item.status = status;
        item.decidedAt = now;

        if (status === "confirmed" && item.kind === "speaker-range" && speaker) {
            item.speaker = speaker;
        }

        if (status === "confirmed" && item.kind === "term" && proposed) {
            item.proposed = proposed;
        }

        corrections.push(...decisionLedger(prior, ledgerEntryFor(record, item, now)));
    }

    return {
        history: {
            command: status === "confirmed" ? "confirm" : "reject",
            change: deciding.map((item) => item.id).join(" "),
        },
        skipped,
        corrections,
        stamps: true,
    };
}

/** The value a respelling sets, per kind: a refusal for a kind that has no text to edit. */
function respellItem(record: MeetingRecord, item: MeetingItem, text: string): DecisionSkip | undefined {
    switch (item.kind) {
        case "term":
            if (item.status === "confirmed" && item.proposed === text) {
                return { id: item.id, reason: `it is confirmed as "${text}" already`, needs: "nothing" };
            }

            item.proposed = text;
            delete item.quote;
            delete item.meaning;
            return undefined;
        case "speaker-range":
            if (item.status === "confirmed" && item.speaker === text) {
                return { id: item.id, reason: `it is confirmed as ${text} already`, needs: "nothing" };
            }

            item.speaker = text;
            return undefined;
        case "join":
            if (item.status === "confirmed" && item.joined === text) {
                return { id: item.id, reason: `it is confirmed as "${text}" already`, needs: "nothing" };
            }

            item.joined = text;
            return undefined;
        case "question": {
            const label = questionLabel(record, item.id);
            return {
                id: item.id,
                reason: `${label} is a question; answer it: ${TOOL} listen ${record.id} --item ${label} --answer "${text}"`,
                needs: "listen",
            };
        }
        case "label":
            return {
                id: item.id,
                reason: "a label that tracks no one person has no text to respell",
                needs: "nothing",
            };
    }
}

/** The item as it was before its decision, from what the item itself kept (`decision.previous`, else suggested). */
function restorePrevious(item: MeetingItem): void {
    const previous = item.decision?.previous;
    item.status = previous?.status ?? "suggested";

    if (previous?.decidedAt) {
        item.decidedAt = previous.decidedAt;
    } else {
        delete item.decidedAt;
    }

    if (previous && item.kind === "speaker-range") {
        if (previous.speaker) {
            item.speaker = previous.speaker;
        } else {
            delete item.speaker;
        }
    }

    if (previous && item.kind === "term") {
        if (previous.proposed) {
            item.proposed = previous.proposed;
        } else {
            delete item.proposed;
        }
    }

    delete item.decision;
}

function reopenSkips(record: MeetingRecord, picked: MeetingItem[]): DecisionSkip[] {
    return picked.flatMap((item): DecisionSkip[] => {
        if (item.kind === "question") {
            const label = questionLabel(record, item.id);
            const token = item.decision?.token;
            return [
                {
                    id: item.id,
                    reason: token
                        ? `${label} is a question; take its answer back: ${TOOL} reopen ${record.id} ${label} --token ${token}`
                        : `${label} is a question; its answer is undone in listen`,
                    needs: "nothing",
                },
            ];
        }

        return item.status === "suggested" ? [{ id: item.id, reason: "it is not decided", needs: "nothing" }] : [];
    });
}

/** Writes `items` (changed in place or replaced) back into the record, and the ledger lines their change makes. */
function putBack(record: MeetingRecord, restore: Map<string, (item: MeetingItem) => MeetingItem>, now: string) {
    const corrections: Correction[] = [];
    record.items = record.items.map((item) => {
        const back = restore.get(item.id);

        if (!back) {
            return item;
        }

        const confirmation = ledgerEntryFor(record, item, now);
        const restored = back(item);
        // The Undo of a reject or a respelling brings the earlier confirmation back, so the ledger confirms it again.
        corrections.push(...decisionLedger(confirmation, ledgerEntryFor(record, restored, now)));
        return restored;
    });
    return corrections;
}

/** A revert of a token the journal never wrote: a decision made before the journal, undone from `decision.previous`. */
function revertUnjournaled(record: MeetingRecord, token: string, refs: string[] | undefined, now: string) {
    const ids = refs
        ? refs.map((ref) => itemIdOf(record, ref))
        : record.items.filter((item) => item.decision?.token === token).map((item) => item.id);
    const picked = pickItems(record, ids);
    const skipped = reopenSkips(record, picked);
    const reopening = picked.filter((item) => !skipped.some((skip) => skip.id === item.id));
    const changed = reopening.filter((item) => item.decision?.token !== token);

    if (changed.length > 0) {
        throw new MeetingsConflictError(
            "item-changed",
            `${changed.map((item) => `${item.id} (${item.status} now)`).join(", ")} was decided again after the decision this Undo names; nothing was reopened`
        );
    }

    const restore = new Map(
        reopening.map((item) => [
            item.id,
            (current: MeetingItem) => {
                restorePrevious(current);
                return current;
            },
        ])
    );
    return { skipped, corrections: putBack(record, restore, now), ids: reopening.map((item) => item.id) };
}

/** The changes of `entry` a revert of `refs` covers: a question named brings back its whole answer. */
function revertScope(
    record: MeetingRecord,
    entry: JournalEntry,
    refs: string[] | undefined
): { scope: ItemChange[]; skipped: DecisionSkip[] } {
    if (!refs) {
        return { scope: entry.changes, skipped: [] };
    }

    const ids = refs.map((ref) => itemIdOf(record, ref));
    const touched = new Set(entry.changes.map((change) => change.id));
    const whole = ids.some(
        (id) => touched.has(id) && entry.changes.find((change) => change.id === id)?.after?.kind === "question"
    );
    const outside = ids.filter((id) => !touched.has(id));
    const named = pickItems(record, outside);
    const skipped = reopenSkips(record, named);
    const decidedElsewhere = named.filter((item) => !skipped.some((skip) => skip.id === item.id));

    if (decidedElsewhere.length > 0) {
        throw new MeetingsConflictError(
            "item-changed",
            `${decidedElsewhere.map((item) => `${item.id} (${item.status} now)`).join(", ")} was decided by another decision than the one this Undo names; nothing was reopened`
        );
    }

    return { scope: whole ? entry.changes : entry.changes.filter((change) => ids.includes(change.id)), skipped };
}

const ACTIONS: { [K in JournalActionKind]: ActionHandler<K> } = {
    confirm: { mutate: (record, action, { now }) => decideItems(record, "confirmed", action, now) },
    reject: { mutate: (record, action, { now }) => decideItems(record, "rejected", action, now) },
    respell: {
        mutate: (record, action, { now }) => {
            const id = itemIdOf(record, action.item);
            const item = pickItems(record, [id])[0]!;
            const text = action.text.trim();

            if (!text) {
                throw new Error(`A respelling of ${action.item} needs the new text`);
            }

            const prior = ledgerEntryFor(record, item, now);
            const skip = respellItem(record, item, text);

            if (skip) {
                return { history: { command: "respell", change: "" }, skipped: [skip], stamps: true };
            }

            item.status = "confirmed";
            item.decidedAt = now;
            return {
                history: { command: "respell", change: `${id} → ${text}` },
                corrections: decisionLedger(prior, ledgerEntryFor(record, item, now)),
                stamps: true,
            };
        },
    },
    answer: {
        mutate: (record, action, { now, listenBelow }) => {
            const { question, skip } = openQuestion(record, action.question);

            if (!question) {
                return { history: { command: "listen", change: "" }, skipped: skip ? [skip] : [], stamps: true };
            }

            const corrections = answerQuestion(record, question.id, {
                answer: action.answer,
                ...(action.comment ? { comment: action.comment } : {}),
                now,
            });
            const alike = settleLookAlikes(record, question, { answer: action.answer, listenBelow, now });
            return {
                history: { command: "listen", change: `${question.id} → ${action.answer}` },
                settled: alike.settled,
                corrections: [...corrections, ...alike.corrections],
                question: question.id,
                stamps: true,
            };
        },
    },
    skip: {
        mutate: (record, action, { now }) => {
            const { question, skip } = openQuestion(record, action.question);

            if (!question) {
                return { history: { command: "listen", change: "" }, skipped: skip ? [skip] : [], stamps: true };
            }

            skipQuestion(record, question.id, now);
            return {
                history: { command: "listen", change: `${question.id} skipped` },
                question: question.id,
                stamps: true,
            };
        },
    },
    split: {
        prepare: async (record, _action, inputs) => {
            if (!inputs) {
                throw new Error("A split needs the meeting's transcript; this journal was made without it");
            }

            const micShare = await inputs.micShare?.(record);
            return { transcript: await inputs.transcript(record), ...(micShare ? { micShare } : {}) };
        },
        mutate: (record, action, { now, prepared }) => {
            const { question, skip } = openQuestion(record, action.question);

            if (!question || !prepared.transcript) {
                return { history: { command: "listen", change: "" }, skipped: skip ? [skip] : [], stamps: true };
            }

            splitQuestion(record, question.id, {
                transcript: prepared.transcript,
                now,
                ...(prepared.micShare ? { micShare: prepared.micShare } : {}),
            });
            return {
                history: { command: "listen", change: `${question.id} split per line and voice` },
                question: question.id,
                stamps: true,
            };
        },
    },
    rename: {
        mutate: (record, action) => {
            const name = action.name.trim();

            if (!name) {
                throw new Error(`a rename of ${action.label} needs a name`);
            }

            if (name === action.label) {
                delete record.speakers.labels[action.label];
            } else {
                record.speakers.labels[action.label] = name;
            }

            return { history: { command: "speakers rename", change: `${action.label} → ${name}` }, stamps: false };
        },
    },
    reopen: {
        mutate: (record, action, { now, entryOf }) => {
            const picked = pickItems(
                record,
                action.items.map((ref) => itemIdOf(record, ref))
            );
            const skipped = reopenSkips(record, picked);
            const reopening = picked.filter((item) => !skipped.some((skip) => skip.id === item.id));
            // Each item goes back to the state before its own last decision: the journal's snapshot when it has
            // one, else what the item kept (a decision older than the journal).
            const restore = new Map(
                reopening.map((item) => {
                    const change = entryOf(item.decision?.token)?.changes.find((one) => one.id === item.id);
                    const back = (current: MeetingItem): MeetingItem => {
                        if (change?.before) {
                            return revertFields(current, change.before, change.after);
                        }

                        restorePrevious(current);
                        return current;
                    };
                    return [item.id, back] as const;
                })
            );
            return {
                history: { command: "reopen", change: reopening.map((item) => item.id).join(" ") },
                skipped,
                corrections: putBack(record, restore, now),
                stamps: false,
            };
        },
    },
    revert: {
        mutate: (record, action, { now, entryOf }) => {
            const target = entryOf(action.token);

            if (!target) {
                const legacy = revertUnjournaled(record, action.token, action.items, now);
                return {
                    history: { command: "reopen", change: legacy.ids.join(" ") },
                    skipped: legacy.skipped,
                    corrections: legacy.corrections,
                    stamps: false,
                };
            }

            const { scope, skipped } = revertScope(record, target, action.items);
            const current = new Map(record.items.map((item) => [item.id, item]));
            const pending = scope.filter((change) => {
                const item = current.get(change.id);

                if (!item) {
                    return change.after === undefined;
                }

                if (change.before && same(item, change.before)) {
                    const reason =
                        item.status === "suggested"
                            ? "it is not decided"
                            : "it is as it was before that decision already";
                    skipped.push({ id: change.id, reason, needs: "nothing" });
                    return false;
                }

                return true;
            });
            const changedSince = pending.filter((change) => {
                const item = current.get(change.id);
                return item !== undefined && item.decision?.token !== change.after?.decision?.token;
            });

            if (changedSince.length > 0) {
                throw new MeetingsConflictError(
                    "item-changed",
                    `${changedSince.map((change) => `${change.id} (${current.get(change.id)?.status} now)`).join(", ")} was decided again after the decision this Undo names; nothing was reopened`
                );
            }

            // A label already back to its name before needs nothing; one renamed again since refuses the Undo.
            const labels = action.items
                ? []
                : target.labels.filter((label) => record.speakers.labels[label.label] !== label.before);
            const labelsSince = labels.filter((label) => record.speakers.labels[label.label] !== label.after);

            if (labelsSince.length > 0) {
                throw new MeetingsConflictError(
                    "item-changed",
                    `${labelsSince.map((label) => label.label).join(", ")} was renamed again after the decision this Undo names; nothing was undone`
                );
            }

            const corrections: Correction[] = [];
            const before = new Map(record.items.map((item) => [item.id, ledgerEntryFor(record, item, now)]));
            record.items = revertChanges(record.items, pending);

            for (const change of pending) {
                const item = record.items.find((one) => one.id === change.id);
                corrections.push(
                    ...decisionLedger(before.get(change.id), item ? ledgerEntryFor(record, item, now) : undefined)
                );
            }

            for (const label of labels) {
                if (label.before === undefined) {
                    delete record.speakers.labels[label.label];
                } else {
                    record.speakers.labels[label.label] = label.before;
                }
            }

            return {
                history: { command: "reopen", change: pending.map((change) => change.id).join(" ") },
                skipped,
                corrections,
                ...(target.question && pending.some((change) => change.id === target.question)
                    ? { question: target.question }
                    : {}),
                stamps: false,
            };
        },
    },
};

/** Runs one action's handler; the kind and the action travel together so the table entry and its action agree. */
function handlerOf<K extends JournalActionKind>(kind: K): ActionHandler<K> {
    return ACTIONS[kind];
}

function labelChanges(before: Record<string, string>, after: Record<string, string>): LabelChange[] {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((label) =>
        before[label] === after[label]
            ? []
            : [
                  {
                      label,
                      ...(before[label] !== undefined ? { before: before[label] } : {}),
                      ...(after[label] !== undefined ? { after: after[label] } : {}),
                  },
              ]
    );
}

/**
 * The answer log's line for an entry, the one `--subscribe-answers` prints: an answer, a skip, a split, or the Undo
 * of one of them (`reopened`). Other decisions are not part of a listening round and write none.
 */
function answerEventOf(entry: JournalEntry, reverted: JournalEntry | undefined): AnswerEvent | undefined {
    const { action, at } = entry;

    if (action.kind === "revert") {
        const item = entry.question;

        if (!reverted || !item) {
            return undefined;
        }

        return { event: "reopened", at, item, ...(reverted.settled.length > 0 ? { also: reverted.settled } : {}) };
    }

    const item = entry.question;
    const question = entry.changes.find((change) => change.id === item)?.after;

    if (!item || question?.kind !== "question") {
        return undefined;
    }

    if (action.kind === "skip") {
        return { event: "skipped", at, item };
    }

    if (action.kind === "split") {
        const into = entry.changes.filter((change) => !change.before && change.after?.kind === "question").length;
        return { event: "split", at, item, into };
    }

    if (action.kind !== "answer") {
        return undefined;
    }

    return {
        event: "answered",
        at,
        item,
        about: question.about,
        fromSec: question.fromSec,
        toSec: question.toSec,
        question: question.question,
        ...(question.heard ? { heard: question.heard } : {}),
        answer: action.answer,
        ...(action.comment ? { comment: action.comment } : {}),
        settled: entry.settled,
        decided: entry.changes.flatMap((change) =>
            change.id !== item && change.after && change.before?.status !== change.after.status
                ? [{ item: change.id, status: change.after.status }]
                : []
        ),
    };
}

/**
 * Who is calling this process, as a decision's actor: an agent with its harness and session, else a person at the
 * command line. The Meetings service takes it from a connection's hello instead; until then the CLI fills it here.
 */
export function callerActor(
    identity: Pick<AgentIdentity, "agent" | "sessionId" | "isInAgent"> = whoIsCallingHere()
): DecisionActor {
    return identity.isInAgent && identity.agent !== "unknown"
        ? { kind: "agent", harness: identity.agent, session: identity.sessionId }
        : { kind: "cli" };
}

/** Who decided an item last; a decision older than the journal reads as `unknown`. */
export function actorOf(item: MeetingItem): DecisionActor {
    return item.decision?.actor ?? { kind: "unknown" };
}

/** An actor in words, for a row or a journal line: "you in the window", "agent claude-code (session 3f98b772)". */
export function actorText(actor: DecisionActor): string {
    switch (actor.kind) {
        case "window":
            return "you in the window";
        case "listen":
            return "you in listen";
        case "cli":
            return "the command line";
        case "agent":
            return `agent ${actor.harness}${actor.session ? ` (session ${actor.session.slice(0, 8)})` : ""}`;
        case "rule":
            return `rule ${actor.rule}`;
        case "unknown":
            return "unknown";
    }
}

/**
 * The decision journal of the meetings store: every decision on a meeting goes through it. `apply` makes one decision
 * (a confirm, a reject, a respelling, an answer with its comment, a skip, a split, a speaker rename, a reopen), records
 * its actor and reason, and keeps the before and after of every item it changed under one token; `plan` answers the
 * same entry without saving anything (the look-alikes an answer would settle); `revert` undoes exactly one entry and is
 * refused with `item-changed` once a later decision changed one of its items; `read` lists a meeting's entries, newest
 * first. It is the one writer of the journal file, of the answer log's decision lines and of the corrections ledger,
 * all under the record's lock, so they keep the record's order.
 */
export class DecisionJournal {
    constructor(private readonly options: DecisionJournalOptions) {}

    /** Makes one decision and saves it. `entry` is absent when it changed nothing (`skipped` says why). */
    async apply(request: DecisionRequest): Promise<Decided> {
        return this.run(request.meeting, request.action, request, true);
    }

    /** The decision `apply` would make now, without saving anything: no record, journal, log or ledger write. */
    async plan(request: DecisionRequest): Promise<Decided> {
        return this.run(request.meeting, request.action, request, false);
    }

    /** Undoes the entry `token` names, or only `items` of it. Refused (`item-changed`) when a later decision changed one. */
    async revert(request: RevertRequest): Promise<Decided> {
        const action: JournalAction = {
            kind: "revert",
            token: request.token,
            ...(request.items ? { items: request.items } : {}),
        };
        return this.run(request.meeting, action, request, true);
    }

    /** A meeting's entries, newest first; `item`: only those that changed it. */
    read(meeting: string, filter: { item?: string; limit?: number } = {}): JournalReadEntry[] {
        const entries = this.entries(meeting);
        const byToken = new Map(entries.map((entry) => [entry.token, entry]));
        const revertedBy = new Map<string, string>();

        // An Undo that gave back every item its entry decided (the window and `reopen --token` name them) undid it whole.
        for (const entry of entries) {
            const target = entry.action.kind === "revert" ? byToken.get(entry.action.token) : undefined;
            const undone = new Set(entry.changes.map((change) => change.id));
            const decided = target?.decided.length ? target.decided : target?.changes.map((change) => change.id);

            if (target && (decided ?? []).every((id) => undone.has(id))) {
                revertedBy.set(target.token, entry.token);
            }
        }

        const listed = entries
            .filter((entry) => !filter.item || entry.changes.some((change) => change.id === filter.item))
            .reverse()
            .map((entry) => {
                const by = revertedBy.get(entry.token);
                return by ? { ...entry, revertedBy: by } : entry;
            });
        return filter.limit === undefined ? listed : listed.slice(0, filter.limit);
    }

    /** The journal file of a meeting. */
    path(meeting: string): string {
        return join(this.options.store.folder(meeting), JOURNAL_FILE);
    }

    private entries(meeting: string): JournalEntry[] {
        const path = this.path(meeting);

        if (!existsSync(path)) {
            return [];
        }

        return Array.from(readLinesSync(path))
            .filter((line) => line.trim())
            .flatMap((line) => {
                const parsed = journalEntrySchema.safeParse(SafeJSON.parse(line, { jsonl: true }));

                if (!parsed.success) {
                    log.warn({ path, error: parsed.error.message }, "decision journal line does not parse; skipped");
                    return [];
                }

                return [parsed.data];
            });
    }

    private async run(
        meeting: string,
        action: JournalAction,
        request: { actor: DecisionActor; reason?: string },
        save: boolean
    ): Promise<Decided> {
        const { store } = this.options;
        const handler = handlerOf(action.kind);
        const saved = store.read(meeting);

        if (!saved) {
            throw new Error(`No meeting ${meeting} (or its record does not validate): ${store.path(meeting)}`);
        }

        const prepared = handler.prepare ? await handler.prepare(saved, action, this.options.split) : {};
        const at = (this.options.now?.() ?? new Date()).toISOString();
        const token = randomUUID();
        const known = new Map<string, JournalEntry | undefined>();
        const context: ActionContext = {
            now: at,
            listenBelow: this.options.listenBelow ?? DEFAULT_LISTEN_BELOW,
            prepared,
            entryOf: (wanted) => {
                if (!wanted) {
                    return undefined;
                }

                if (!known.has(wanted)) {
                    known.set(
                        wanted,
                        this.entries(meeting).find((entry) => entry.token === wanted)
                    );
                }

                return known.get(wanted);
            },
        };
        let result: Decided = { skipped: [] };
        // Filled in by the handler: the store reads it after the change, for the record's history line.
        const history: MeetingChange = { command: action.kind, change: "" };
        const decide = (record: MeetingRecord): boolean => {
            const items = structuredClone(record.items);
            const labels = { ...record.speakers.labels };
            const outcome = handler.mutate(record, action, context);
            Object.assign(history, outcome.history);
            let changes = itemChanges(items, record.items);
            const labelled = labelChanges(labels, record.speakers.labels);

            if (changes.length === 0 && labelled.length === 0) {
                result = { skipped: outcome.skipped ?? [] };
                return false;
            }

            const decided = changes
                .filter(
                    (change) =>
                        change.before &&
                        change.after &&
                        (change.before.status !== change.after.status ||
                            change.before.decidedAt !== change.after.decidedAt)
                )
                .map((change) => change.id);

            if (outcome.stamps) {
                this.stamp(record, decided, items, { token, action, request, question: outcome.question });
                changes = itemChanges(items, record.items);
            }

            result = {
                entry: {
                    token,
                    at,
                    meeting,
                    actor: request.actor,
                    ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
                    action,
                    ...(outcome.question ? { question: outcome.question } : {}),
                    decided: outcome.stamps ? decided : [],
                    settled: outcome.settled ?? [],
                    skipped: outcome.skipped ?? [],
                    changes,
                    labels: labelled,
                    corrections: outcome.corrections ?? [],
                },
                skipped: outcome.skipped ?? [],
            };
            return true;
        };

        if (!save) {
            decide(structuredClone(saved));
            return result;
        }

        await store.update(
            meeting,
            history,
            (record) => decide(record),
            () => {
                if (result.entry) {
                    this.write(result.entry, action.kind === "revert" ? context.entryOf(action.token) : undefined);
                }
            }
        );
        return result;
    }

    /** Puts who decided, how and why on each item a decision decided, with the fields it changed as they were. */
    private stamp(
        record: MeetingRecord,
        decided: string[],
        before: MeetingItem[],
        stamp: {
            token: string;
            action: JournalAction;
            request: { actor: DecisionActor; reason?: string };
            question?: string;
        }
    ): void {
        const was = new Map(before.map((item) => [item.id, item]));
        const reason = stamp.request.reason?.trim();

        for (const item of record.items) {
            const old = was.get(item.id);

            if (!old || !decided.includes(item.id)) {
                continue;
            }

            item.decision = {
                token: stamp.token,
                previous: {
                    status: old.status,
                    ...(old.decidedAt ? { decidedAt: old.decidedAt } : {}),
                    ...(old.kind === "speaker-range" && old.speaker ? { speaker: old.speaker } : {}),
                    ...(old.kind === "term" && old.proposed ? { proposed: old.proposed } : {}),
                },
                actor: stamp.request.actor,
                entry: {
                    action: stamp.action.kind,
                    ...(reason ? { reason } : {}),
                    ...(stamp.question ? { question: stamp.question } : {}),
                },
            };
        }
    }

    /** The entry's line, its answer log line and its ledger lines, in that order, under the record's lock. */
    private write(entry: JournalEntry, reverted: JournalEntry | undefined): void {
        const { store } = this.options;
        appendFileSync(this.path(entry.meeting), `${SafeJSON.stringify(entry, { jsonl: true })}\n`, { mode: 0o600 });
        const event = answerEventOf(entry, reverted);

        if (event) {
            appendAnswerEvent(join(store.folder(entry.meeting), ANSWER_LOG_FILE), event);
        }

        (this.options.ledger ?? appendCorrections)(entry.corrections);
        log.debug(
            { meeting: entry.meeting, action: entry.action.kind, token: entry.token, changed: entry.changes.length },
            "decision journaled"
        );
    }
}
