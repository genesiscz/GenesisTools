import { formatLocalDate } from "@genesiscz/utils/date";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingItem, MeetingRecord, MeetingStore } from "@genesiscz/utils/meetings/record";
import { LINE_AT_TOLERANCE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import type { DecisionAction, JournalEntry } from "./decision-actions";
import { DecisionJournal } from "./decision-journal";
import { type DecidedLine, itemLines, personKey } from "./listen-answers";
import { NONE_OF_THESE, type QuestionItem } from "./questions";

interface KnownSpeaker {
    name: string;
    meeting: string;
    date: string;
}

type Votes = Map<string, KnownSpeaker | null>;

export type KnownAnswer = NonNullable<Extract<DecisionAction, { kind: "answer" }>["knownAnswer"]>;

function agreement(previous: KnownSpeaker | null | undefined, answer: KnownSpeaker | null): KnownSpeaker | null {
    if (previous === null || !answer || (previous && personKey(previous.name) !== personKey(answer.name))) {
        return null;
    }
    return !previous || answer.date > previous.date ? answer : previous;
}

/** Match copies on the source words, label and clock. Only identical simultaneous lines need the index as well. */
class SpeakerLines {
    readonly transcript: TranscriptLines;
    readonly keys: string[];

    constructor(entries: TranscriptEntry[]) {
        this.transcript = new TranscriptLines(entries);
        const keys = entries.map((line) =>
            SafeJSON.stringify([line.startSec, line.speaker, line.text], { strict: true })
        );
        const seen = new Set<string>();
        const duplicates = new Set<string>();
        for (const key of keys) {
            if (seen.has(key)) {
                duplicates.add(key);
            }
            seen.add(key);
        }
        this.keys = keys.map((key, index) => (duplicates.has(key) ? `${key}#${index}` : key));
    }

    of(item: MeetingItem): DecidedLine[] {
        const lines = itemLines(item, this.transcript);
        const index = item.evidence?.transcriptLine;
        return typeof index === "number" && "fromSec" in item && item.fromSec === item.toSec
            ? lines.filter((line) => line.index === index)
            : lines;
    }

    targets(record: MeetingRecord, question: QuestionItem): string[] {
        const byId = new Map(record.items.map((one) => [one.id, one]));
        const targets = question.decides.length ? question.decides.map((id) => byId.get(id)) : [question];
        const lines = new Set<string>();
        for (const target of targets) {
            const part = target && this.of(target);
            if (!part?.length) {
                return [];
            }
            for (const line of part) {
                lines.add(this.keys[line.index]!);
            }
        }
        return [...lines];
    }
}

/** Only the original question and its direct, still-confirmed targets are human evidence. */
function itemVotes(
    entry: JournalEntry,
    items: Map<string, MeetingItem>,
    lines: SpeakerLines,
    add: (key: string, name?: string) => void
): void {
    const action = entry.action;
    if (
        action.kind !== "answer" &&
        action.kind !== "respell" &&
        !(action.kind === "confirm" && action.minConfidence === undefined)
    ) {
        return;
    }
    const primary = entry.changes.find((change) => change.id === entry.question)?.after;
    for (const { id, after } of entry.changes) {
        const item = items.get(id);
        if (
            !item ||
            after?.status !== item.status ||
            (item.decision ? item.decision.token !== entry.token : !item.decidedAt || item.decidedAt !== entry.at)
        ) {
            continue;
        }
        if (
            action.kind === "answer" &&
            (primary?.kind !== "question" ||
                primary.about !== "speaker" ||
                (id !== primary.id && !primary.decides.includes(id)))
        ) {
            continue;
        }
        let name: string | undefined;
        if (item.kind === "question" && item.id === entry.question && !item.decides.length) {
            name = item.answer;
        } else if (item.kind === "speaker-range" || item.kind === "join") {
            name = item.speaker;
        } else {
            continue;
        }
        if (
            item.status === "rejected" ||
            name?.toLowerCase() === NONE_OF_THESE ||
            (item.kind === "speaker-range" && (item.voices?.length ?? 0) > 1) ||
            (item.kind === "question" && name?.includes(" + "))
        ) {
            name = undefined;
        }
        for (const line of lines.of(item)) {
            add(lines.keys[line.index]!, name);
        }
    }
}

/** Evidence is rebuilt when the deciding items or assignments change, including Undo in another window. */
export class KnownSpeakerAnswers {
    private readonly lines = new Map<string, Promise<SpeakerLines | undefined>>();
    private readonly cached = new Map<string, { revision: number; votes: Votes }>();
    private readonly journal: DecisionJournal;

    constructor(
        private readonly deps: {
            store: MeetingStore;
            transcript: (record: MeetingRecord) => Promise<TranscriptEntry[]>;
        }
    ) {
        this.journal = new DecisionJournal({ store: deps.store });
    }

    private transcript(record: MeetingRecord): Promise<SpeakerLines | undefined> {
        const source = SafeJSON.stringify([record.id, record.sources], { strict: true });
        let lines = this.lines.get(source);
        if (!lines) {
            lines = this.deps
                .transcript(record)
                .then((entries) => new SpeakerLines(entries))
                .catch((error: unknown) => {
                    logger.debug(
                        { error, meeting: record.id },
                        "cannot match known answers without the source transcript"
                    );
                    return undefined;
                });
            this.lines.set(source, lines);
        }
        return lines;
    }

    private async votes(record: MeetingRecord): Promise<Votes> {
        const cached = this.cached.get(record.id);
        if (cached?.revision === record.history.length) {
            return cached.votes;
        }
        const items = record.items.filter(
            (item) =>
                (item.status === "confirmed" ||
                    (item.status === "rejected" && item.decision?.entry?.action === "answer")) &&
                (item.kind === "speaker-range" ||
                    item.kind === "join" ||
                    (item.kind === "question" && item.about === "speaker"))
        );
        const votes: Votes = new Map();
        const lines = await this.transcript(record);
        if (
            lines &&
            (items.length || record.speakers.assignments?.length || Object.keys(record.speakers.labels).length)
        ) {
            const byId = new Map(items.map((item) => [item.id, item]));
            for (const entry of this.journal.read(record.id)) {
                if (
                    entry.meeting !== record.id ||
                    entry.revertedBy ||
                    !["window", "listen", "cli"].includes(entry.actor.kind)
                ) {
                    continue;
                }
                const action = entry.action;
                const replay = action.kind === "answer" ? action.knownAnswer : undefined;
                const add = (key: string, name?: string) =>
                    votes.set(
                        key,
                        agreement(
                            votes.get(key),
                            name
                                ? {
                                      name,
                                      meeting: replay?.meeting ?? entry.copiedFrom ?? record.id,
                                      date: replay?.date ?? formatLocalDate(new Date(entry.at)),
                                  }
                                : null
                        )
                    );
                if (action.kind === "assign" || action.kind === "rename") {
                    const assignments =
                        entry.assignments?.flatMap(({ after }) =>
                            after &&
                            record.speakers.assignments?.some(
                                (now) => now.id === after.id && now.at === after.at && now.person === after.person
                            )
                                ? [after]
                                : []
                        ) ?? [];
                    for (const [index, line] of lines.transcript.entries.entries()) {
                        if (
                            action.kind === "rename" &&
                            action.label === line.speaker &&
                            record.speakers.labels[action.label] === action.name
                        ) {
                            add(lines.keys[index]!, action.name);
                        }
                        for (const assignment of assignments) {
                            if (
                                assignment.label === line.speaker &&
                                line.startSec !== undefined &&
                                line.startSec >= assignment.fromSec - LINE_AT_TOLERANCE_SEC &&
                                line.startSec <= assignment.toSec + LINE_AT_TOLERANCE_SEC
                            ) {
                                add(lines.keys[index]!, assignment.person);
                            }
                        }
                    }
                    continue;
                }
                itemVotes(entry, byId, lines, add);
            }
        }
        this.cached.set(record.id, { revision: record.history.length, votes });
        return votes;
    }

    async find(
        record: MeetingRecord,
        question: QuestionItem
    ): Promise<{ name: string; origin: KnownAnswer } | undefined> {
        const lines = await this.transcript(record);
        const target = lines?.targets(record, question);
        if (!target?.length) {
            return undefined;
        }
        const creation = record.history[0];
        const source =
            creation?.command === "duplicate" &&
            /^duplicated from ([A-Za-z0-9][\w.-]*)(?: without items)?$/.exec(creation.change)?.[1];
        const original = source ? this.deps.store.read(source) : undefined;
        const sources = [await this.votes(record)];
        if (original && original.id === source) {
            sources.push(await this.votes(original));
        }
        let found: KnownSpeaker | null | undefined;
        for (const key of target) {
            const votes = sources.flatMap((one) => (one.has(key) ? [one.get(key) ?? null] : []));
            if (!votes.length) {
                return undefined;
            }
            for (const answer of votes) {
                found = agreement(found, answer);
                if (!found) {
                    return undefined;
                }
            }
        }
        return found
            ? {
                  name: found.name,
                  origin: {
                      meeting: found.meeting,
                      date: found.date,
                      revision: record.history.length,
                      ...(original ? { source: { id: original.id, revision: original.history.length } } : {}),
                  },
              }
            : undefined;
    }
}
