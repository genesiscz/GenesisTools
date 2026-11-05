import { isDeepStrictEqual } from "node:util";
import { logger } from "@genesiscz/utils/logger";
import { appendCorrections, type Correction } from "@genesiscz/utils/meetings/corrections";
import {
    type MeetingItem,
    type MeetingRecord,
    type MeetingStore,
    meetingItemSchema,
} from "@genesiscz/utils/meetings/record";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { type AnswerEvent, appendAnswerEvent, type RoundEndReason, roundRunning } from "./answer-log";
import {
    answerQuestion,
    openQuestions,
    type QuestionItem,
    questionLabel,
    settleLookAlikes,
    skipQuestion,
    splitQuestion,
} from "./questions";

const { log } = logger.scoped("meetings-listen");

export interface ListenAnswer {
    answer: string;
    comment?: string;
}

/** What a person did with one asked question. `back` undoes the previous decision; `split` asks "Several voices". */
export type ListenOutcome = ListenAnswer | "skip" | "split" | "stop" | "back";

/** One question as the session asks it: where it sits in the round, counted in budget units. */
export interface AskedQuestion {
    question: QuestionItem;
    /** The record as it is now, for the question's view. */
    record: MeetingRecord;
    /** `Q12`. */
    label: string;
    /** The question's unit in the round, 1-based: a split's parts share their parent's unit. */
    position: number;
    /** How many units this round asks at most: the budget, or fewer when fewer questions are open. */
    total: number;
    /** A part of a split question: which part of how many. */
    part?: { n: number; of: number };
    /** The answer this round gave the same heard words at another time: offered first. */
    earlier?: { answer: string; atSec: number };
}

/** What the session tells the person; each adapter words it its own way. Labels are `Q12`. */
export type SessionNote =
    | { kind: "decided"; label: string; outcome: ListenAnswer | "skip"; settled: string[] }
    | { kind: "split"; label: string; parts: number }
    | { kind: "not-split"; label: string }
    | { kind: "undone"; label: string }
    | { kind: "ended"; reason: RoundEndReason; decided: number; open: number; budget: number };

/** One way a person answers a session's questions: the terminal with audio, or an answer given on the command line. */
export interface ListenAdapter {
    ask(asked: AskedQuestion): Promise<ListenOutcome>;
    /** Esc on the round's first question: true leaves the round. */
    confirmLeave(): Promise<boolean>;
    note(note: SessionNote): void;
}

export type MicShare = (fromSec: number, toSec: number) => number | undefined;

/** What "Several voices" needs to cut a question: the transcript, and the microphone's share when it is known. */
export interface SplitInputs {
    transcript(record: MeetingRecord): Promise<TranscriptEntry[]>;
    micShare?(record: MeetingRecord): Promise<MicShare | undefined>;
}

export interface ListenSessionOptions {
    store: MeetingStore;
    meeting: MeetingRecord;
    /** The answer log (`questions.ndjson` in the meeting's folder). */
    logPath: string;
    adapter: ListenAdapter;
    /** Ask only this question (an item id), and the parts it is split into. */
    only?: string;
    budget: number;
    minPriority: number;
    listenBelow: number;
    split: SplitInputs;
    /** A round already running in the log is joined, not opened again: an answer given while a person listens. */
    joinRunningRound?: boolean;
    /** Where confirmed corrections go when the round ends; the corrections ledger by default. */
    ledger?: (corrections: Correction[]) => void;
}

/** One item a decision changed: its state before (absent: the decision created it) and after. */
export interface ItemChange {
    id: string;
    before?: MeetingItem;
    after: MeetingItem;
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

/** The items `after` differs from `before` in, each with both states. */
export function itemChanges(before: MeetingItem[], after: MeetingItem[]): ItemChange[] {
    const old = new Map(before.map((item) => [item.id, item]));
    return after.flatMap((item) => {
        const was = old.get(item.id);

        if (was && same(was, item)) {
            return [];
        }

        return [{ id: item.id, ...(was ? { before: was } : {}), after: structuredClone(item) }];
    });
}

function revertFields(item: MeetingItem, before: MeetingItem, after: MeetingItem): MeetingItem {
    const next: Record<string, unknown> = { ...item };
    const was: Record<string, unknown> = before;
    const changed: Record<string, unknown> = after;

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
 * The inverse of `changes`: each field a decision set goes back to its value before, and an item it created goes
 * away. Items and fields changed by anyone else since (an `items add` during the round) stay as they are.
 */
export function revertChanges(items: MeetingItem[], changes: ItemChange[]): MeetingItem[] {
    const byId = new Map(changes.map((change) => [change.id, change]));
    return items.flatMap((item) => {
        const change = byId.get(item.id);

        if (!change) {
            return [item];
        }

        if (!change.before) {
            return same(item, change.after) ? [] : [item];
        }

        return [revertFields(item, change.before, change.after)];
    });
}

/** One decision of the round, with what it changed, so Esc can undo exactly that. */
interface Step {
    question: QuestionItem;
    changes: ItemChange[];
    /** Written when the round ends, so an undone answer leaves no correction behind. */
    corrections: Correction[];
    answer?: string;
    /** The look-alikes the answer settled. */
    settled: string[];
    /** A split: the parts it made. It uses no budget; its parts share its unit. */
    parts?: string[];
}

/**
 * One listening round over a meeting's open questions. It owns which question comes next (`only` and split parts),
 * the budget, each decision as per-item changes with their inverse, settling look-alikes, the answer log and the
 * corrections ledger. A `ListenAdapter` asks the person; the session never prompts or plays audio itself.
 */
export class ListenSession {
    private readonly steps: Step[] = [];
    /** A part made by a split in this round, and the question it was cut from. */
    private readonly parentOf = new Map<string, string>();
    private micShare?: Promise<MicShare | undefined>;
    private ownsRound = false;
    private ended = false;

    constructor(private readonly options: ListenSessionOptions) {}

    /** Asks question after question until none is left, the budget is used, or the person stops. */
    async run(): Promise<RoundEndReason> {
        this.start();
        let reason: RoundEndReason = "done";
        let reask: string | undefined;

        try {
            while (true) {
                const record = this.current();
                const question = this.next(record, reask);
                reask = undefined;

                if (!question) {
                    break;
                }

                const used = this.usedUnits();

                if (!used.includes(this.rootOf(question.id)) && used.length >= this.options.budget) {
                    reason = "budget";
                    break;
                }

                const outcome = await this.options.adapter.ask(this.asked(record, question, used));

                if (outcome === "stop") {
                    reason = "stopped";
                    break;
                }

                if (outcome === "back") {
                    const undone = await this.undo();

                    if (undone) {
                        reask = undone;
                        continue;
                    }

                    if (await this.options.adapter.confirmLeave()) {
                        reason = "stopped";
                        break;
                    }

                    reask = question.id;
                    continue;
                }

                if (outcome === "split") {
                    if (!(await this.split(question))) {
                        reask = question.id;
                    }

                    continue;
                }

                await this.decide(question, outcome);
            }
        } catch (error) {
            reason = "aborted";
            throw error;
        } finally {
            this.end(reason);
        }

        return reason;
    }

    /** Closes the round once: writes the ledger and the round-end. Safe to call from an exit handler. */
    end(reason: RoundEndReason): void {
        if (this.ended) {
            return;
        }

        this.ended = true;
        (this.options.ledger ?? appendCorrections)(this.steps.flatMap((step) => step.corrections));
        const open = openQuestions(this.current()).length;
        const decided = this.decidedCount();

        if (this.ownsRound) {
            this.log({ event: "round-end", at: new Date().toISOString(), reason, asked: decided, open });
        }

        this.options.adapter.note({ kind: "ended", reason, decided, open, budget: this.options.budget });
    }

    private start(): void {
        const { logPath, joinRunningRound } = this.options;
        this.ownsRound = !(joinRunningRound && roundRunning(logPath));

        if (this.ownsRound) {
            const open = Math.min(this.options.budget, this.openUnits(this.current()).size || 1);
            this.log({ event: "round-start", at: new Date().toISOString(), pid: process.pid, open });
        }
    }

    private current(): MeetingRecord {
        return this.options.store.read(this.options.meeting.id) ?? this.options.meeting;
    }

    private log(event: AnswerEvent): void {
        appendAnswerEvent(this.options.logPath, event);
    }

    private rootOf(id: string): string {
        let at = id;

        while (this.parentOf.has(at)) {
            at = this.parentOf.get(at)!;
        }

        return at;
    }

    private inScope(question: QuestionItem): boolean {
        const { only, minPriority } = this.options;

        if (this.parentOf.has(question.id)) {
            return true;
        }

        if (only) {
            return question.id === only;
        }

        return (question.priority ?? minPriority) >= minPriority;
    }

    /** The question asked again (after Esc), else a part of a split, else the most valuable open one in scope. */
    private next(record: MeetingRecord, reask?: string): QuestionItem | undefined {
        const open = openQuestions(record);
        const again = reask ? open.find((question) => question.id === reask) : undefined;
        return (
            again ??
            open.find((question) => this.parentOf.has(question.id)) ??
            open.find((question) => this.inScope(question))
        );
    }

    private decidedCount(): number {
        return this.steps.filter((step) => !step.parts).length;
    }

    /** The budget units used, in the order they were first used: one per decided question, its parts included. */
    private usedUnits(): string[] {
        return [...new Set(this.steps.filter((step) => !step.parts).map((step) => this.rootOf(step.question.id)))];
    }

    private openUnits(record: MeetingRecord): Set<string> {
        return new Set(
            openQuestions(record)
                .filter((question) => this.inScope(question))
                .map((question) => this.rootOf(question.id))
        );
    }

    private asked(record: MeetingRecord, question: QuestionItem, used: string[]): AskedQuestion {
        const root = this.rootOf(question.id);
        const position = used.includes(root) ? used.indexOf(root) + 1 : used.length + 1;
        const units = new Set([...used, ...this.openUnits(record), root]).size;
        const parent = this.parentOf.get(question.id);
        const siblings = parent ? this.steps.findLast((step) => step.question.id === parent)?.parts : undefined;
        const earlier = this.earlierFor(question);
        return {
            question,
            record,
            label: questionLabel(record, question.id),
            position,
            total: Math.max(position, Math.min(this.options.budget, units)),
            ...(siblings ? { part: { n: siblings.indexOf(question.id) + 1, of: siblings.length } } : {}),
            ...(earlier ? { earlier } : {}),
        };
    }

    private earlierFor(question: QuestionItem): { answer: string; atSec: number } | undefined {
        const heard = question.heard?.toLowerCase();
        const step = heard
            ? this.steps.findLast((done) => done.answer !== undefined && done.question.heard?.toLowerCase() === heard)
            : undefined;
        return step?.answer === undefined ? undefined : { answer: step.answer, atSec: step.question.fromSec };
    }

    /** Runs `mutate` on the stored record and returns what it changed, item by item. */
    private async change(change: string, mutate: (record: MeetingRecord) => void): Promise<ItemChange[]> {
        let changes: ItemChange[] = [];
        await this.options.store.update(this.options.meeting.id, { command: "listen", change }, (current) => {
            const before = structuredClone(current.items);
            mutate(current);
            changes = itemChanges(before, current.items);
        });
        return changes;
    }

    private async decide(question: QuestionItem, outcome: ListenAnswer | "skip"): Promise<void> {
        const now = new Date().toISOString();
        const corrections: Correction[] = [];
        let settled: string[] = [];
        const changes = await this.change(
            outcome === "skip" ? `${question.id} skipped` : `${question.id} → ${outcome.answer}`,
            (current) => {
                if (outcome === "skip") {
                    skipQuestion(current, question.id, now);
                    return;
                }

                corrections.push(...answerQuestion(current, question.id, { ...outcome, now }));
                const alike = settleLookAlikes(current, question, {
                    answer: outcome.answer,
                    listenBelow: this.options.listenBelow,
                    now,
                });
                settled = alike.settled;
                corrections.push(...alike.corrections);
            }
        );
        this.steps.push({
            question,
            changes,
            corrections,
            settled,
            ...(outcome === "skip" ? {} : { answer: outcome.answer }),
        });
        this.log(
            outcome === "skip"
                ? { event: "skipped", at: now, item: question.id }
                : {
                      event: "answered",
                      at: now,
                      item: question.id,
                      about: question.about,
                      fromSec: question.fromSec,
                      toSec: question.toSec,
                      question: question.question,
                      ...(question.heard ? { heard: question.heard } : {}),
                      answer: outcome.answer,
                      ...(outcome.comment ? { comment: outcome.comment } : {}),
                      settled,
                  }
        );
        log.info({ meeting: this.options.meeting.id, question: question.id, outcome, settled }, "question decided");
        const record = this.current();
        this.options.adapter.note({
            kind: "decided",
            label: questionLabel(record, question.id),
            outcome,
            settled: settled.map((id) => questionLabel(record, id)),
        });
    }

    /** Undoes the last decision, only what it changed; returns its question, or nothing at the round's start. */
    private async undo(): Promise<string | undefined> {
        // The step stays until the store took the undo, so a failed write keeps its ledger entry and its inverse.
        const last = this.steps.at(-1);

        if (!last) {
            return undefined;
        }

        await this.options.store.update(
            this.options.meeting.id,
            { command: "listen", change: `${last.question.id} reopened` },
            (next) => {
                next.items = revertChanges(next.items, last.changes);
            }
        );

        this.steps.pop();

        for (const part of last.parts ?? []) {
            this.parentOf.delete(part);
        }

        this.log({
            event: "reopened",
            at: new Date().toISOString(),
            item: last.question.id,
            ...(last.settled.length > 0 ? { also: last.settled } : {}),
        });
        this.options.adapter.note({ kind: "undone", label: questionLabel(this.current(), last.question.id) });
        return last.question.id;
    }

    /** "Several voices": cuts the question into parts that come next; false when there is nothing to cut at. */
    private async split(question: QuestionItem): Promise<boolean> {
        const record = this.current();
        const transcript = await this.options.split.transcript(record);
        this.micShare ??= this.options.split.micShare?.(record) ?? Promise.resolve(undefined);
        const micShare = await this.micShare;
        const now = new Date().toISOString();
        let parts: QuestionItem[] = [];
        const changes = await this.change(`${question.id} split per line and voice`, (current) => {
            parts = splitQuestion(current, question.id, { transcript, now, ...(micShare ? { micShare } : {}) });
        });
        const label = questionLabel(record, question.id);

        if (parts.length === 0) {
            this.options.adapter.note({ kind: "not-split", label });
            return false;
        }

        for (const part of parts) {
            this.parentOf.set(part.id, question.id);
        }

        this.steps.push({ question, changes, corrections: [], settled: [], parts: parts.map((part) => part.id) });
        this.log({ event: "split", at: now, item: question.id, into: parts.length });
        this.options.adapter.note({ kind: "split", label, parts: parts.length });
        return true;
    }
}
