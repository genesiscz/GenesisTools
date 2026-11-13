import { randomUUID } from "node:crypto";
import { existsSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import type { AgentIdentity } from "@genesiscz/utils/agent/identity";
import { harnessLabel, harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import { readLinesSync } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { mergeLabels } from "@genesiscz/utils/meetings/config";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import { appendCorrections, type Correction, teachesDictionary } from "@genesiscz/utils/meetings/corrections";
import {
    type DecisionActor,
    MEETING_UNCHANGED,
    type MeetingChange,
    type MeetingItem,
    type MeetingRecord,
    type MeetingStore,
    meetingItemSchema,
    type SpellingReach,
} from "@genesiscz/utils/meetings/record";
import { heardLineAt } from "@genesiscz/utils/transcribe/apply";
import { heardIn, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { prepareFindings } from "./add-findings";
import { ANSWER_LOG_FILE, type AnswerEvent, appendAnswerEvent, appendAnswerEvents, roundRunning } from "./answer-log";
import {
    type CommentAction,
    type Decided,
    type DecisionAction,
    type DecisionSkip,
    type FieldChange,
    type ItemChange,
    JOURNAL_FILE,
    type JournalAction,
    type JournalEntry,
    type JournalReadEntry,
    journalEntrySchema,
    type LabelChange,
    MEETING_FIELDS,
} from "./decision-actions";
import { appendLines } from "./ndjson-lines";
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
import type { ReviewRow } from "./review-row-schema";
import { TOOL } from "./shared";
import {
    type AssignReachStretch,
    assignmentChanges,
    assignmentsOf,
    assignmentText,
    assignNeedsTranscript,
    putAssignments,
    renameJoinsWarning,
    revertAssignments,
} from "./speaker-assign";
import { decisionLedger, ledgerEntryFor, lineOf } from "./transcript-corrections";

const { log } = logger.scoped("meetings-journal");

export {
    type Decided,
    type DecisionAction,
    type DecisionSkip,
    decisionActionSchema,
    type FieldChange,
    type ItemChange,
    JOURNAL_FILE,
    type JournalEntry,
    type JournalReadEntry,
    journalEntrySchema,
    type LabelChange,
    SKIP_NEEDS,
} from "./decision-actions";

/** The actions that change the record; a `comment` entry is history only (`note`). */
type RecordAction = Exclude<JournalAction, { kind: "comment" }>;
type JournalActionKind = RecordAction["kind"];
type ActionOf<K extends JournalActionKind> = Extract<RecordAction, { kind: K }>;

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
    /** Internal observer of one committed mutation, with both snapshots taken under the record lock. */
    onApplied?: (snapshot: { before: MeetingRecord; after: MeetingRecord }) => void;
    /** An answer settles look-alikes that reach this confidence (`global.suggest.listenBelow`). */
    listenBelow?: number;
    /** Where the corrections a decision confirms or withdraws go; the corrections ledger by default. */
    ledger?: (corrections: Correction[]) => void;
    /** The transcript and microphone share a split needs; an `add` anchors its findings to the same transcript. */
    split?: SplitInputs;
    now?: () => Date;
    /**
     * An answer, a skip or a split made while no listen round runs writes its own one-question round around its answer
     * log line (round-start, the line, round-end in one append), as `listen --answer` does, so a subscriber that waits
     * for a round's end hears it. The Meetings service sets it; a listen round writes its own round lines.
     */
    ownRound?: boolean;
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
    /** Notes besides the skips (an added finding whose transcript anchor did not match). */
    warnings?: string[];
}

/** Read before the record's lock, for the actions that need more than the record (a split's transcript). */
interface Prepared {
    transcript?: TranscriptEntry[];
    micShare?: MicShare;
}

type FieldValues = Record<(typeof MEETING_FIELDS)[number], string | string[] | undefined>;

/** The meeting's own fields as a `set` and its Undo see them. */
function fieldValues(record: MeetingRecord): FieldValues {
    return { project: record.project, title: record.title, labels: [...record.labels] };
}

function fieldChanges(was: FieldValues, now: FieldValues): FieldChange[] {
    return MEETING_FIELDS.flatMap((field) =>
        same(was[field], now[field])
            ? []
            : [
                  {
                      field,
                      ...(was[field] !== undefined ? { before: was[field] } : {}),
                      ...(now[field] !== undefined ? { after: now[field] } : {}),
                  },
              ]
    );
}

/** Puts one field of the record back to `value` (absent: no value). */
function putField(record: MeetingRecord, field: FieldChange["field"], value: FieldChange["before"]): void {
    if (field === "labels") {
        record.labels = Array.isArray(value) ? [...value] : [];
        return;
    }

    const text = typeof value === "string" ? value : undefined;

    if (field === "project") {
        if (text === undefined) {
            delete record.project;
        } else {
            record.project = text;
        }

        return;
    }

    record.title = text ?? record.title;
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
    action: { items: string[]; minConfidence?: number; speaker?: string; proposed?: string; reach?: SpellingReach },
    now: string
): ActionOutcome {
    const { minConfidence, speaker, proposed, reach } = action;

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
    if (reach && (picked.length !== 1 || picked[0]?.kind !== "term")) {
        throw new Error("Spelling reach needs exactly one term item");
    }

    // Deciding an item the same way again changes nothing, so it mints no token that would void the first Undo (MC16).
    for (const item of picked) {
        const changes =
            status === "confirmed" &&
            ((item.kind === "speaker-range" && speaker !== undefined && speaker !== item.speaker) ||
                (item.kind === "term" &&
                    ((proposed !== undefined && proposed !== item.proposed) ||
                        (reach !== undefined && !same(reach, item.reach)))));

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

        if (status === "confirmed" && item.kind === "term") {
            if (proposed) {
                item.proposed = proposed;
            }
            if (reach !== undefined) {
                item.reach = structuredClone(reach);
            }
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
        if (previous.reach) {
            item.reach = structuredClone(previous.reach);
        } else {
            delete item.reach;
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

function replacementScope(options: {
    record: MeetingRecord;
    earlier: JournalEntry;
    question: string;
    except: string[];
}): { entry: JournalEntry; except: string[]; skipped: DecisionSkip[] } {
    const { record, earlier, question } = options;
    const except = new Set(options.except.filter((id) => id !== question));
    const current = new Map(record.items.map((item) => [item.id, item]));
    const changes = new Map(earlier.changes.map((change) => [change.id, change]));
    const skipped: DecisionSkip[] = [];

    for (const change of earlier.changes) {
        if (
            change.id !== question &&
            !except.has(change.id) &&
            current.get(change.id)?.decision?.token !== change.after?.decision?.token
        ) {
            except.add(change.id);
            skipped.push({ id: change.id, reason: "its decision changed since the earlier answer", needs: "nothing" });
        }
    }

    const restoredTargets = earlier.changes.flatMap((change) =>
        change.before?.kind === "question" ? change.before.decides : []
    );
    for (const id of restoredTargets) {
        const item = current.get(id);
        if (id !== question && !changes.has(id) && item && item.status !== "suggested" && !except.has(id)) {
            except.add(id);
            skipped.push({ id, reason: "its decision changed since the earlier answer", needs: "nothing" });
        }
    }

    // Keeping a look-alike question also keeps the targets its answer set.
    for (const id of except) {
        const item = changes.get(id)?.after;
        if (item?.kind === "question") {
            for (const target of item.decides) {
                if (target !== question) {
                    except.add(target);
                }
            }
        }
    }

    return {
        entry: { ...earlier, changes: earlier.changes.filter((change) => !except.has(change.id)) },
        except: [...except],
        skipped,
    };
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

            if (action.reach && item.kind !== "term") {
                throw new Error("Spelling reach needs a term item");
            }
            const prior = ledgerEntryFor(record, item, now);
            const reachChanged = item.kind === "term" && action.reach !== undefined && !same(action.reach, item.reach);
            const skip = respellItem(record, item, text);

            if (skip && !reachChanged) {
                return { history: { command: "respell", change: "" }, skipped: [skip], stamps: true };
            }

            if (item.kind === "term" && action.reach !== undefined) {
                item.reach = structuredClone(action.reach);
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
    rephrase: {
        mutate: (record, action) => {
            const id = itemIdOf(record, action.question);
            const item = pickItems(record, [id])[0]!;
            if (item.kind !== "question") {
                throw new Error(`${action.question} is not a question`);
            }
            if (action.expectedText !== undefined && item.question !== action.expectedText) {
                throw new MeetingsConflictError(
                    "item-changed",
                    "The question wording changed since this draft opened; reload it before saving"
                );
            }
            item.question = action.text.trim();
            return { history: { command: "rephrase", change: `${id}: ${item.question}` }, stamps: false };
        },
    },
    answer: {
        mutate: (record, action, context) => {
            const { now, listenBelow } = context;
            let except = (action.except ?? []).map((ref) => itemIdOf(record, ref));
            let undone: Correction[] = [];
            const skipped: DecisionSkip[] = [];

            if (action.replaces) {
                const id = itemIdOf(record, action.question);
                const earlier = context.entryOf(action.replaces);
                if (earlier?.action.kind !== "answer" || (earlier.question !== id && !earlier.settled.includes(id))) {
                    throw new Error("The replacement token must name an earlier answer to this question");
                }

                if (action.lookAlikes === "leave") {
                    const otherQuestions = [earlier.question, ...earlier.settled].filter(
                        (other): other is string => other !== undefined && other !== id
                    );
                    except.push(...otherQuestions);
                }

                const scope = replacementScope({ record, earlier, question: id, except });
                except = scope.except;
                skipped.push(...scope.skipped);
                undone =
                    ACTIONS.revert.mutate(
                        record,
                        { kind: "revert", token: earlier.token },
                        {
                            ...context,
                            entryOf: (token) => (token === earlier.token ? scope.entry : context.entryOf(token)),
                        }
                    ).corrections ?? [];

                // Undoing a replacement can restore a confirmed older answer. Only the questions in this
                // replacement's scope reopen so the new answer can update them and their look-alikes.
                const questions = new Set(
                    scope.entry.changes.filter((change) => change.after?.kind === "question").map((change) => change.id)
                );
                for (const item of record.items) {
                    if (item.kind === "question" && questions.has(item.id)) {
                        item.status = "suggested";
                    }
                }
            }

            const { question, skip } = openQuestion(record, action.question);
            if (!question) {
                return {
                    history: { command: "listen", change: "" },
                    skipped: [...skipped, ...(skip ? [skip] : [])],
                    stamps: true,
                };
            }

            const propagationSource = structuredClone(question);
            const corrections = answerQuestion(record, question.id, {
                answer: action.answer,
                ...(action.comment ? { comment: action.comment } : {}),
                now,
                except,
            });
            const alike =
                action.lookAlikes === "leave"
                    ? { settled: [], corrections: [] }
                    : settleLookAlikes(record, propagationSource, { answer: action.answer, listenBelow, now, except });
            return {
                history: { command: "listen", change: `${question.id} → ${action.answer}` },
                settled: alike.settled,
                corrections: [...undone, ...corrections, ...alike.corrections],
                skipped,
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

            const joins = renameJoinsWarning(record, action.label, name);

            if (name === action.label) {
                delete record.speakers.labels[action.label];
            } else {
                record.speakers.labels[action.label] = name;
            }

            return {
                history: { command: "speakers rename", change: `${action.label} → ${name}` },
                ...(joins ? { warnings: [joins] } : {}),
                stamps: false,
            };
        },
    },
    assign: {
        prepare: async (record, action, inputs) => {
            // A stretch with its label needs no transcript; a stretch of every voice, or a line by its start, does.
            if (!assignNeedsTranscript(action)) {
                return {};
            }

            if (!inputs) {
                throw new Error(
                    "An assignment of lines needs the meeting's transcript; this journal was made without it"
                );
            }

            return { transcript: await inputs.transcript(record) };
        },
        mutate: (record, action, { now, prepared }) => {
            const { assigned, skipped } = assignmentsOf(action, prepared.transcript);
            putAssignments(record, assigned, now);
            const change = assigned.map((one) => `${assignmentText(one)} → ${one.person}`).join(", ");
            return { history: { command: "speakers assign", change }, skipped, stamps: false };
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
    add: {
        prepare: async (record, _action, inputs) => {
            // The transcript anchors each join and line-bound term to one line; with none at hand, items go in as given.
            const transcript = await inputs?.transcript(record).catch((error: unknown) => {
                log.debug({ error, meeting: record.id }, "no transcript to check the anchors against");
                return undefined;
            });
            return transcript ? { transcript } : {};
        },
        mutate: (record, action, { prepared }) => {
            const { added, warnings } = prepareFindings({
                findings: action.findings,
                items: record.items,
                ...(prepared.transcript ? { transcript: prepared.transcript } : {}),
            });
            record.items.push(...added);
            return {
                history: { command: "items add", change: `${action.findings.length} findings` },
                warnings,
                stamps: false,
            };
        },
    },
    set: {
        mutate: (record, action) => {
            const labels = action.labels ?? [];
            const unlabel = action.unlabel ?? [];
            const removed = new Set(unlabel.map((label) => label.toLowerCase()));
            record.project = action.project ?? record.project;
            record.title = action.title ?? record.title;
            record.labels = mergeLabels(record.labels, labels).filter((label) => !removed.has(label.toLowerCase()));
            const change = [
                action.project ? `project ${action.project}` : "",
                action.title ? `title "${action.title}"` : "",
                labels.length > 0 ? `labels + ${labels.join(", ")}` : "",
                unlabel.length > 0 ? `labels - ${unlabel.join(", ")}` : "",
            ].filter(Boolean);
            return { history: { command: "set", change: change.join(", ") }, stamps: false };
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
                return (
                    item !== undefined &&
                    (item.decision?.token !== change.after?.decision?.token ||
                        (target.action.kind === "rephrase" && !same(item, change.after)))
                );
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

            // A meeting field already back needs nothing; one changed again since refuses the Undo, as an item does.
            const values = fieldValues(record);
            const fields = action.items
                ? []
                : (target.fields ?? []).filter((field) => !same(values[field.field], field.before));
            const fieldsSince = fields.filter((field) => !same(values[field.field], field.after));

            if (fieldsSince.length > 0) {
                throw new MeetingsConflictError(
                    "item-changed",
                    `the ${fieldsSince.map((field) => field.field).join(" and ")} of ${record.id} changed again after the decision this Undo names; nothing was undone`
                );
            }

            for (const field of fields) {
                putField(record, field.field, field.before);
            }

            if (!action.items) {
                revertAssignments(record, target.assignments ?? []);
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

            const unassigned = action.items ? [] : (target.assignments ?? []).map((change) => change.id);
            return {
                history: {
                    command: "reopen",
                    change: [...pending.map((change) => change.id), ...unassigned].join(" "),
                },
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

/**
 * What a planned decision reaches beyond the items it names, for the window's "This also affects" sheet (R22, G9,
 * G26, G27): the other items it changes, the transcript lines a spelling changes, and the dictionary it teaches.
 */
/**
 * How a reached item stands to the decision. `sets`: a target of the decided question outside the span it asks
 * about, which the answer also sets ("This answer also sets"); `look-alike`: another question or item the engine
 * settles the same way; `same`: the same question again (a target inside the asked span, a look-alike over the same
 * span), closed with it and never asked twice (genesiscz.md 9).
 */
export type ReachRole = "sets" | "look-alike" | "same";

/** One item a decision reaches beyond the ones it names, with the evidence a person judges it by. */
export interface ReachItem {
    id: string;
    match: "same";
    role: ReachRole;
    /** What a person sees the item as before the decision and after it: a speaker, a spelling, an answer. */
    before?: string;
    after?: string;
    /** The item's own review row (`reviewRow`): its quote, its time and its play target, as the row list shows them. */
    row?: ReviewRow;
    /** The answer this one replaces left it out: the sheet shows it struck, and one click puts it back. */
    struck?: boolean;
}

/**
 * What a planned decision reaches beyond the items it names, for the window's "This also affects" sheet (R22, G9,
 * G26, G27): the other items it changes, the transcript lines a spelling changes, and the dictionary it teaches.
 */
export interface DecisionReach {
    /**
     * Items besides the named ones: the targets an answer also sets, the look-alikes it settles, and the same question
     * over the same span (closed with it). A look-alike question's own targets go with it and are not listed apart.
     */
    items: ReachItem[];
    spelling?: {
        occurrences: Array<{
            line: number;
            atSec: number;
            speaker: string;
            text: string;
            selected: boolean;
            primary: boolean;
        }>;
        dictionary: boolean;
    };
    /** Transcript lines whose heard words a confirmed spelling fixes (a term fixed everywhere); absent without a transcript. */
    lines?: number;
    /**
     * Spellings fixed everywhere also teach the dictionary: `dictionary suggest` proposes a fix confirmed in
     * `CORRECTION_REPEATS` meetings. `seenBefore`: other confirmed sightings in the ledger (this project's); `teaches`:
     * this decision makes it a suggestion.
     */
    dictionary: Array<{ project?: string; heard: string; fixed: string; seenBefore: number; teaches: boolean }>;
    /**
     * An assignment's other stretches (`assign`): the same label inside the hint range that holds the assigned
     * stretch, or in the sections with the same people present; absent for other actions.
     */
    stretches?: AssignReachStretch[];
}

/** Where an item sits in the meeting: a range, or one point for a word. */
function spanOf(item: MeetingItem): { fromSec: number; toSec: number } | undefined {
    if (item.kind === "term" || item.kind === "join") {
        return item.atSec === undefined ? undefined : { fromSec: item.atSec, toSec: item.atSec };
    }

    return { fromSec: item.fromSec, toSec: item.toSec };
}

/** What a person sees an item as: a range's speaker, a word's spelling, a question's answer. */
function shownValue(item: MeetingItem | undefined): string | undefined {
    switch (item?.kind) {
        case "speaker-range":
            return item.speaker ?? item.label;
        case "term":
            return item.proposed ?? item.heard;
        case "question":
            return item.answer;
        default:
            return undefined;
    }
}

/** A tolerance for "the same span": the engine's times are rounded to tenths, a hand-made range to seconds. */
const SAME_SPAN_SEC = 0.5;

/** The reach of a planned entry, from the record it was planned on, its transcript (when read) and the ledger. */
export function decisionReach(options: {
    entry: JournalEntry;
    /** The items the action names, which are not reach. */
    named: string[];
    /** The record the decision was planned on (before it): the decided question's targets and each item's span. */
    record?: MeetingRecord;
    /** The review row of a reached item, built from the record before the decision (its quote, time and target). */
    rowOf?: (item: MeetingItem) => ReviewRow | undefined;
    /** Items the answer this one replaces left out: shown struck. */
    struck?: readonly string[];
    transcript?: readonly TranscriptEntry[];
    ledger: readonly Correction[];
    repeats: number;
}): DecisionReach {
    const { entry } = options;
    const named = new Set([...options.named, ...(entry.question ? [entry.question] : [])]);
    const before = new Map((options.record?.items ?? []).map((item) => [item.id, item]));
    const changeOf = new Map(entry.changes.map((change) => [change.id, change]));
    const itemOf = (id: string) => before.get(id) ?? changeOf.get(id)?.before ?? changeOf.get(id)?.after;
    const decidesOf = (id: string): string[] => {
        const versions = [before.get(id), changeOf.get(id)?.before, changeOf.get(id)?.after];
        return versions.flatMap((item) => (item?.kind === "question" ? item.decides : []));
    };
    const asked = entry.question ? itemOf(entry.question) : undefined;
    const askedSpan = asked ? spanOf(asked) : undefined;
    const targets = new Set(entry.question ? decidesOf(entry.question) : []);
    const namedSpans = [...named].flatMap((id) => {
        const item = itemOf(id);
        const span = item ? spanOf(item) : undefined;
        return span ? [span] : [];
    });
    // A look-alike question carries its own targets; they are judged with it, not one by one.
    const carried = new Set(entry.settled.flatMap((id) => decidesOf(id)));
    const struck = new Set(options.struck ?? []);
    const sameSpan = (span: { fromSec: number; toSec: number }) =>
        namedSpans.some(
            (one) =>
                Math.abs(one.fromSec - span.fromSec) <= SAME_SPAN_SEC &&
                Math.abs(one.toSec - span.toSec) <= SAME_SPAN_SEC
        );
    const insideAsked = (span: { fromSec: number; toSec: number }) =>
        askedSpan !== undefined &&
        span.fromSec >= askedSpan.fromSec - SAME_SPAN_SEC &&
        span.toSec <= askedSpan.toSec + SAME_SPAN_SEC;
    const items = [...new Set([...entry.settled, ...entry.decided, ...[...struck].filter((id) => targets.has(id))])]
        .filter((id) => !named.has(id) && !(carried.has(id) && !targets.has(id)))
        .map((id): ReachItem => {
            const item = itemOf(id);
            const span = item ? spanOf(item) : undefined;
            const role: ReachRole = targets.has(id)
                ? span && insideAsked(span)
                    ? "same"
                    : "sets"
                : span && sameSpan(span)
                  ? "same"
                  : "look-alike";
            const was = shownValue(changeOf.get(id)?.before ?? before.get(id));
            const will = shownValue(changeOf.get(id)?.after);
            const row = item ? options.rowOf?.(item) : undefined;
            return {
                id,
                match: "same",
                role,
                ...(was ? { before: was } : {}),
                ...(will ? { after: will } : {}),
                ...(row ? { row } : {}),
                ...(struck.has(id) ? { struck: true } : {}),
            };
        });
    const taught = entry.corrections.filter((correction) => teachesDictionary(correction) && !correction.retracted);
    const lines = options.transcript
        ? options.transcript.filter((line) => {
              const text = line.text.toLowerCase();
              return taught.some((correction) => text.includes(correction.heard.toLowerCase()));
          }).length
        : undefined;
    const dictionary = taught.map((correction) => {
        // One live confirmation per other meeting item, as `dictionary suggest` counts them (an Undo withdraws one).
        const live = new Map<string, boolean>();

        for (const line of options.ledger) {
            if (
                teachesDictionary(line) &&
                line.project === correction.project &&
                line.heard === correction.heard &&
                line.fixed === correction.fixed &&
                !(line.meeting === correction.meeting && line.item === correction.item)
            ) {
                live.set(`${line.meeting}\n${line.item}`, !line.retracted);
            }
        }

        const seenBefore = [...live.values()].filter(Boolean).length;
        return {
            ...(correction.project ? { project: correction.project } : {}),
            heard: correction.heard,
            fixed: correction.fixed,
            seenBefore,
            teaches: seenBefore + 1 >= options.repeats,
        };
    });
    const changedTerms = entry.changes.flatMap((change) => (change.after?.kind === "term" ? [change.after] : []));
    const term =
        (entry.action.kind === "confirm" || entry.action.kind === "respell") && changedTerms.length === 1
            ? changedTerms[0]
            : undefined;
    let spelling: DecisionReach["spelling"];
    if (term) {
        const transcript = options.transcript ?? [];
        const source = new TranscriptLines(transcript);
        const at = term.atSec;
        const anchor =
            at === undefined ? undefined : heardLineAt(source, { atSec: at, line: lineOf(term) }, term.heard);
        const primary = anchor?.kind === "found" ? anchor.index : undefined;
        const selectedLines = term.reach?.lines
            ? new Set(
                  term.reach.lines.flatMap((point) => {
                      const found = heardLineAt(source, point, term.heard);
                      return found.kind === "found" ? [found.index] : [];
                  })
              )
            : undefined;
        const occurrences = transcript.flatMap((line, index) => {
            if (line.startSec === undefined || heardIn(line.text, term.heard).length === 0) {
                return [];
            }
            const selected = selectedLines
                ? selectedLines.has(index)
                : term.scope === "line"
                  ? index === primary
                  : true;
            return [
                {
                    line: index,
                    atSec: line.startSec,
                    speaker: options.record?.speakers.labels[line.speaker] ?? line.speaker,
                    text: line.text,
                    selected,
                    primary: index === primary,
                },
            ];
        });
        spelling = {
            occurrences,
            dictionary: term.reach?.dictionary ?? (term.reach?.lines === undefined && term.scope !== "line"),
        };
    }
    return {
        items,
        ...(taught.length > 0 && lines !== undefined ? { lines } : {}),
        dictionary,
        ...(spelling ? { spelling } : {}),
    };
}

/** An agent's harness by the name a person knows it by (its driver's label); an agent no driver claims shows its id. */
function harnessText(agent: string): string {
    const harness = harnessOfRuntimeAgent(agent);
    return harness ? harnessLabel(harness) : agent;
}

/**
 * An actor in words, after "by" on a row or a journal line (GLOSSARY.md, "Decision journal"): "by you" (the window),
 * "by you in the terminal" (listen), "by you at the command line", "by an agent (Claude Code, session 3f98b772)",
 * "by rule E2", and "by someone, before the history existed" for a decision older than the journal (never "unknown").
 */
export function actorText(actor: DecisionActor): string {
    switch (actor.kind) {
        case "window":
            return "you";
        case "listen":
            return "you in the terminal";
        case "cli":
            return "you at the command line";
        case "agent": {
            const session = actor.session ? `, session ${actor.session.slice(0, 8)}` : "";
            return `an agent (${harnessText(actor.harness)}${session})`;
        }
        case "rule":
            return `rule ${actor.rule}`;
        case "unknown":
            return "someone, before the history existed";
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

    /**
     * Undoes the entry `token` names, or only `items` of it. Refused (`item-changed`) when a later decision changed one,
     * and for comments sent to the listening agent: it has them.
     */
    async revert(request: RevertRequest): Promise<Decided> {
        const target = this.entries(request.meeting).find((entry) => entry.token === request.token);
        if (target?.action.kind === "unsupported") {
            throw new Error(
                `This decision was made by a newer build (${target.action.name}). Open it in that build to undo it; nothing was changed.`
            );
        }

        if (target?.action.kind === "comment") {
            throw new Error(
                `${request.token} sent comments to the listening agent; a sent comment cannot be taken back.`
            );
        }

        const action: RecordAction = {
            kind: "revert",
            token: request.token,
            ...(request.items ? { items: request.items } : {}),
        };
        return this.run(request.meeting, action, request, true);
    }

    /**
     * An entry that changes nothing in the record, so the history shows it (comments sent to the listening agent,
     * G63). Appended alone: no record write, answer log line or ledger line.
     */
    note(request: { meeting: string; action: CommentAction; actor: DecisionActor; reason?: string }): JournalEntry {
        const entry: JournalEntry = {
            token: randomUUID(),
            at: (this.options.now?.() ?? new Date()).toISOString(),
            meeting: request.meeting,
            actor: request.actor,
            ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
            action: request.action,
            decided: [],
            settled: [],
            skipped: [],
            changes: [],
            labels: [],
            corrections: [],
        };
        appendLines(this.path(request.meeting), [SafeJSON.stringify(entry, { jsonl: true })], { mode: 0o600 });
        log.debug({ meeting: entry.meeting, action: "comment", token: entry.token }, "comments journaled");
        return entry;
    }

    /** A meeting's entries, newest first; `item`: only those that changed it. */
    read(meeting: string, filter: { item?: string; limit?: number } = {}): JournalReadEntry[] {
        const entries = this.entries(meeting);
        const byToken = new Map(entries.map((entry) => [entry.token, entry]));
        const revertedBy = new Map<string, string>();

        // An Undo that gave back every item its entry decided (the window and `reopen --token` name them) undid it whole.
        for (const entry of entries.toReversed()) {
            if (revertedBy.has(entry.token)) {
                continue;
            }

            const target = entry.action.kind === "revert" ? byToken.get(entry.action.token) : undefined;
            const undone = new Set(entry.changes.map((change) => change.id));
            const decided = target?.decided.length ? target.decided : target?.changes.map((change) => change.id);

            if (target && (decided ?? []).every((id) => undone.has(id))) {
                revertedBy.set(target.token, entry.token);
            }
        }

        for (const entry of entries) {
            if (
                entry.action.kind === "answer" &&
                entry.action.replaces &&
                byToken.has(entry.action.replaces) &&
                !revertedBy.has(entry.token)
            ) {
                const target = byToken.get(entry.action.replaces)!;
                const changed = new Set(entry.changes.map((change) => change.id));
                if (target.changes.every((change) => changed.has(change.id))) {
                    revertedBy.set(entry.action.replaces, entry.token);
                }
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
                let value: unknown;

                try {
                    value = SafeJSON.parse(line, { jsonl: true });
                } catch (error) {
                    // A torn line (a crash or a full disk during the append, a hand edit) loses only itself, so the
                    // other entries still read and their tokens still revert.
                    log.warn({ path, error }, "decision journal line is not JSON; skipped");
                    return [];
                }

                const parsed = journalEntrySchema.safeParse(value);

                if (!parsed.success) {
                    log.warn({ path, error: parsed.error.message }, "decision journal line does not parse; skipped");
                    return [];
                }

                return [parsed.data];
            });
    }

    private async run(
        meeting: string,
        action: RecordAction,
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
        // One lazy snapshot per decision, read under the record lock. Reopening many independently confirmed
        // items must not read and parse the whole journal again for each distinct token.
        let known: Map<string, JournalEntry> | undefined;
        const context: ActionContext = {
            now: at,
            listenBelow: this.options.listenBelow ?? DEFAULT_LISTEN_BELOW,
            prepared,
            entryOf: (wanted) => {
                if (!wanted) {
                    return undefined;
                }

                known ??= new Map(this.entries(meeting).map((entry) => [entry.token, entry]));
                const entry = known.get(wanted);
                if (entry && entry.meeting !== meeting) {
                    throw new Error(
                        `Journal entry ${entry.token} belongs to ${entry.meeting}, not ${meeting}; refusing cross-record Undo.`
                    );
                }
                if (entry?.action.kind === "unsupported") {
                    throw new Error(
                        `This decision was made by a newer build (${entry.action.name}). Open it in that build to undo it; nothing was changed.`
                    );
                }
                return entry;
            },
        };
        let result: Decided = { skipped: [] };
        /** Open questions once the decision is made: the round-end of a round it writes itself says it. */
        let openAfter = 0;
        // Filled in by the handler: the store reads it after the change, for the record's history line.
        const history: MeetingChange = { command: action.kind, change: "" };
        let before: MeetingRecord | undefined;
        const decide = (record: MeetingRecord): typeof MEETING_UNCHANGED | undefined => {
            if (this.options.onApplied) {
                before = structuredClone(record);
            }
            const items = structuredClone(record.items);
            const labels = { ...record.speakers.labels };
            const fieldsBefore = fieldValues(record);
            const assignmentsBefore = structuredClone(record.speakers.assignments ?? []);
            const outcome = handler.mutate(record, action, context);
            Object.assign(history, outcome.history);
            let changes = itemChanges(items, record.items);
            const labelled = labelChanges(labels, record.speakers.labels);
            const fielded = fieldChanges(fieldsBefore, fieldValues(record));
            const assigned = assignmentChanges(assignmentsBefore, record.speakers.assignments ?? []);
            const warnings = outcome.warnings?.length ? { warnings: outcome.warnings } : {};

            if (changes.length === 0 && labelled.length === 0 && fielded.length === 0 && assigned.length === 0) {
                result = { skipped: outcome.skipped ?? [], ...warnings };
                return MEETING_UNCHANGED;
            }

            openAfter = openQuestions(record).length;

            const decided = changes
                .filter(
                    (change) =>
                        change.before &&
                        change.after &&
                        // An item a changed answer gave back and left open is not decided by it.
                        change.after.status !== "suggested" &&
                        (change.before.status !== change.after.status ||
                            change.before.decidedAt !== change.after.decidedAt ||
                            // A changed answer took the earlier decision off it and made this one.
                            change.before.decision?.token !== change.after.decision?.token ||
                            (change.before.kind === "term" &&
                                change.after.kind === "term" &&
                                !same(change.before.reach, change.after.reach)))
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
                    ...(fielded.length > 0 ? { fields: fielded } : {}),
                    ...(assigned.length > 0 ? { assignments: assigned } : {}),
                    corrections: outcome.corrections ?? [],
                },
                skipped: outcome.skipped ?? [],
                ...warnings,
            };
            return undefined;
        };

        if (!save) {
            decide(structuredClone(saved));
            return result;
        }

        let takeBack = (): void => {};
        await store.update(meeting, history, decide, {
            write: () => {
                if (result.entry) {
                    takeBack = this.writeLines(result.entry, {
                        reverted: action.kind === "revert" ? context.entryOf(action.token) : undefined,
                        openAfter,
                    });
                }
            },
            undo: () => takeBack(),
            saved: (record) => {
                if (result.entry) {
                    this.writeLedger(result.entry);
                    if (before) {
                        this.options.onApplied?.({ before, after: structuredClone(record) });
                    }
                }
            },
        });
        return result;
    }

    /** Puts who decided, how and why on each item a decision decided, with the fields it changed as they were. */
    private stamp(
        record: MeetingRecord,
        decided: string[],
        before: MeetingItem[],
        stamp: {
            token: string;
            action: RecordAction;
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
                    ...(old.kind === "term" && old.reach ? { reach: structuredClone(old.reach) } : {}),
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

    /**
     * The entry's line and its answer log line, under the record's lock before the record is saved. Answers what takes
     * both back: the store runs it when the record is not saved, so neither file holds a decision the record lacks. A
     * failed append takes back what it already wrote before it throws.
     */
    private writeLines(
        entry: JournalEntry,
        after: { reverted: JournalEntry | undefined; openAfter: number }
    ): () => void {
        const { store } = this.options;
        const journalPath = this.path(entry.meeting);
        const undo = [
            undoableAppend(journalPath, () =>
                appendLines(journalPath, [SafeJSON.stringify(entry, { jsonl: true })], { mode: 0o600 })
            ),
        ];
        const event = answerEventOf(entry, after.reverted);

        if (event) {
            const logPath = join(store.folder(entry.meeting), ANSWER_LOG_FILE);

            try {
                undo.push(
                    undoableAppend(logPath, () => {
                        // One append for the three lines, so a subscriber reads the round's start and end together.
                        if (this.options.ownRound && event.event !== "reopened" && !roundRunning(logPath)) {
                            appendAnswerEvents(logPath, [
                                { event: "round-start", at: entry.at, pid: process.pid, open: 1 },
                                event,
                                {
                                    event: "round-end",
                                    at: entry.at,
                                    reason: "done",
                                    asked: event.event === "split" ? 0 : 1,
                                    open: after.openAfter,
                                },
                            ]);
                        } else {
                            appendAnswerEvent(logPath, event);
                        }
                    })
                );
            } catch (error) {
                undo[0]!();
                throw error;
            }
        }

        log.debug(
            { meeting: entry.meeting, action: entry.action.kind, token: entry.token, changed: entry.changes.length },
            "decision journaled"
        );
        return () => {
            for (const each of undo.reverse()) {
                each();
            }
        };
    }

    /**
     * The entry's ledger lines, once the record is saved, still under its lock (an Undo's retraction never lands before
     * the line it retracts). The ledger is shared by every meeting, so it cannot be cut back: a failure here fails the
     * command, and the decision stays saved and journaled, so its token still reverts it.
     */
    private writeLedger(entry: JournalEntry): void {
        (this.options.ledger ?? appendCorrections)(entry.corrections);
    }
}

/**
 * Runs `append` on `path` and answers how to take it back: the file cut to the length it had (empty when the append
 * made it). An append that throws is taken back before the error goes on. Cutting a file needs no free disk space,
 * so a full disk that failed a write cannot also fail its undo.
 */
function undoableAppend(path: string, append: () => void): () => void {
    const size = existsSync(path) ? statSync(path).size : 0;
    const undo = (): void => {
        if (existsSync(path) && statSync(path).size > size) {
            truncateSync(path, size);
        }
    };

    try {
        append();
    } catch (error) {
        undo();
        throw error;
    }

    return undo;
}
