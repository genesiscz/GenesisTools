import { logger } from "@genesiscz/utils/logger";
import { MeetingsConflictError } from "@genesiscz/utils/meetings/conflict";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import type { DecisionActor, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { type AnswerEvent, appendAnswerEvent, type RoundEndReason, roundRunning } from "./answer-log";
import { DecisionJournal, type JournalEntry, type MicShare, type SplitInputs } from "./decision-journal";
import { openQuestions, type QuestionItem, questionLabel } from "./questions";

export type { MicShare, SplitInputs } from "./decision-journal";

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
    /** Esc found the previous answer decided again by someone else since: it stays, and the round goes on. */
    | { kind: "not-undone"; label: string; reason: string }
    | { kind: "ended"; reason: RoundEndReason; decided: number; open: number; budget: number };

/** One way a person answers a session's questions: the terminal with audio, or an answer given on the command line. */
export interface ListenAdapter {
    ask(asked: AskedQuestion): Promise<ListenOutcome>;
    /** Esc on the round's first question: true leaves the round. */
    confirmLeave(): Promise<boolean>;
    note(note: SessionNote): void;
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
    /** Where the corrections each decision confirms or withdraws go; the corrections ledger by default. */
    ledger?: (corrections: Correction[]) => void;
    /** Who answers: the person in this terminal round by default; an agent that relays a person through `--answer`. */
    actor?: DecisionActor;
    /** Why, kept with each decision of the round. */
    reason?: string;
}

/** One decision of the round, by its decision journal token, so Esc can undo exactly that. */
interface Step {
    question: QuestionItem;
    token: string;
    answer?: string;
    /** The look-alikes the answer settled. */
    settled: string[];
    /** A split: the parts it made. It uses no budget; its parts share its unit. */
    parts?: string[];
}

/**
 * One listening round over a meeting's open questions. It owns which question comes next (`only` and split parts),
 * the budget and the round's lines in the answer log. Every answer, skip and split is a decision journal entry (with
 * its look-alikes, its answer log line and its ledger lines), and Esc reverts the last one by its token. A
 * `ListenAdapter` asks the person; the session never prompts or plays audio itself.
 */
export class ListenSession {
    private readonly steps: Step[] = [];
    /** A part made by a split in this round, and the question it was cut from. */
    private readonly parentOf = new Map<string, string>();
    private readonly journal: DecisionJournal;
    private readonly entries: JournalEntry[] = [];
    private micShare?: Promise<MicShare | undefined>;
    private ownsRound = false;
    private ended = false;
    private roundEnded = false;

    constructor(private readonly options: ListenSessionOptions) {
        const { split } = options;
        this.journal = new DecisionJournal({
            store: options.store,
            listenBelow: options.listenBelow,
            ...(options.ledger ? { ledger: options.ledger } : {}),
            split: {
                transcript: (record) => split.transcript(record),
                // One microphone share per round: a second split reuses it.
                micShare: (record) => {
                    this.micShare ??= split.micShare?.(record) ?? Promise.resolve(undefined);
                    return this.micShare;
                },
            },
        });
    }

    /** The decision journal entries this round made, oldest first (an Esc'd one stays: its revert is an entry too). */
    applied(): JournalEntry[] {
        return [...this.entries];
    }

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
            try {
                this.end("aborted");
            } catch (finalizationError) {
                log.error(
                    { error: finalizationError },
                    "listen finalization failed after an earlier error; end can be retried"
                );
            }
            throw error;
        }

        this.end(reason);
        return reason;
    }

    /** Closes the round once: writes the round-end. Safe to call from an exit handler. */
    end(reason: RoundEndReason): void {
        if (this.ended) {
            return;
        }

        const open = openQuestions(this.current()).length;
        const decided = this.decidedCount();

        if (!this.roundEnded) {
            if (this.ownsRound) {
                this.log({ event: "round-end", at: new Date().toISOString(), reason, asked: decided, open });
            }
            this.roundEnded = true;
        }

        this.options.adapter.note({ kind: "ended", reason, decided, open, budget: this.options.budget });
        this.ended = true;
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

    private actor(): DecisionActor {
        return this.options.actor ?? { kind: "listen" };
    }

    private reason(): { reason?: string } {
        return this.options.reason ? { reason: this.options.reason } : {};
    }

    private async decide(question: QuestionItem, outcome: ListenAnswer | "skip"): Promise<void> {
        const { entry } = await this.journal.apply({
            meeting: this.options.meeting.id,
            action:
                outcome === "skip"
                    ? { kind: "skip", question: question.id }
                    : {
                          kind: "answer",
                          question: question.id,
                          answer: outcome.answer,
                          ...(outcome.comment ? { comment: outcome.comment } : {}),
                      },
            actor: this.actor(),
            ...this.reason(),
        });

        // The question was decided elsewhere while it was asked: that decision stays, and this one is dropped.
        if (!entry) {
            return;
        }

        this.entries.push(entry);
        this.steps.push({
            question,
            token: entry.token,
            settled: entry.settled,
            ...(outcome === "skip" ? {} : { answer: outcome.answer }),
        });
        log.debug(
            { meeting: this.options.meeting.id, question: question.id, outcome, settled: entry.settled },
            "question decided"
        );
        const record = this.current();
        this.options.adapter.note({
            kind: "decided",
            label: questionLabel(record, question.id),
            outcome,
            settled: entry.settled.map((id) => questionLabel(record, id)),
        });
    }

    /** Undoes the last decision through its journal token; returns its question, or nothing at the round's start. */
    private async undo(): Promise<string | undefined> {
        // The step stays until the journal took the revert, so a failed write keeps it and its ledger lines.
        const last = this.steps.at(-1);

        if (!last) {
            return undefined;
        }

        try {
            const { entry } = await this.journal.revert({
                meeting: this.options.meeting.id,
                token: last.token,
                actor: this.actor(),
                ...this.reason(),
            });

            if (entry) {
                this.entries.push(entry);
            }
        } catch (error) {
            if (!(error instanceof MeetingsConflictError)) {
                throw error;
            }

            this.steps.pop();
            this.options.adapter.note({
                kind: "not-undone",
                label: questionLabel(this.current(), last.question.id),
                reason: error.message,
            });
            return last.question.id;
        }

        this.steps.pop();

        for (const part of last.parts ?? []) {
            this.parentOf.delete(part);
        }

        this.options.adapter.note({ kind: "undone", label: questionLabel(this.current(), last.question.id) });
        return last.question.id;
    }

    /** "Several voices": cuts the question into parts that come next; false when there is nothing to cut at. */
    private async split(question: QuestionItem): Promise<boolean> {
        const label = questionLabel(this.current(), question.id);
        const { entry } = await this.journal.apply({
            meeting: this.options.meeting.id,
            action: { kind: "split", question: question.id },
            actor: this.actor(),
            ...this.reason(),
        });
        const parts = (entry?.changes ?? []).flatMap((change) =>
            !change.before && change.after?.kind === "question" ? [change.id] : []
        );

        if (!entry || parts.length === 0) {
            this.options.adapter.note({ kind: "not-split", label });
            return false;
        }

        for (const part of parts) {
            this.parentOf.set(part, question.id);
        }

        this.entries.push(entry);
        this.steps.push({ question, token: entry.token, settled: [], parts });
        this.options.adapter.note({ kind: "split", label, parts: parts.length });
        return true;
    }
}
