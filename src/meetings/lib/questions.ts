import type { Correction } from "@genesiscz/utils/meetings/corrections";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import type { Presence } from "@genesiscz/utils/transcribe/speakers";

/** The answer that rejects every item a question decides. */
export const NONE_OF_THESE = "none of these";

export type QuestionItem = Extract<MeetingItem, { kind: "question" }>;
export type NewQuestion = Omit<QuestionItem, "id" | "suggestedAt">;

/** Items below this confidence are asked by ear, unless the config sets `global.suggest.listenBelow`. */
export const DEFAULT_LISTEN_BELOW = 0.8;

/** A term question hears this much after the word's line starts. */
const TERM_CLIP_SEC = 4;

/**
 * The question a suggested item needs before anyone confirms it: a speaker range marked "confirm by listening" (both
 * channels in its lines) or under `listenBelow`, and a term under `listenBelow` whose time is known. A speaker
 * question offers the item's speaker first, then its candidates, then everyone present during the range.
 */
export function questionFor(
    item: MeetingItem,
    options: { listenBelow: number; presence?: Presence[] }
): NewQuestion | undefined {
    const low = item.confidence !== undefined && item.confidence < options.listenBelow;

    if (item.status !== "suggested") {
        return undefined;
    }

    if (item.kind === "speaker-range" && (low || item.evidence?.listen === true)) {
        // A range ends where its last line starts; the clip must hear that line to its end.
        const lineEnd = item.evidence?.endSec;
        const toSec = typeof lineEnd === "number" ? Math.max(item.toSec, lineEnd) : item.toSec;
        const present = (options.presence ?? [])
            .filter((stay) => stay.fromSec <= toSec && stay.toSec >= item.fromSec)
            .map((stay) => stay.name);
        return {
            kind: "question",
            status: "suggested",
            about: "speaker",
            fromSec: item.fromSec,
            toSec,
            question: `Who speaks under "${item.label}" from ${formatClock(item.fromSec)} to ${formatClock(toSec)}?`,
            choices: [...new Set([...(item.speaker ? [item.speaker] : []), ...(item.candidates ?? []), ...present])],
            decides: [item.id],
            rules: item.rules,
            ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
        };
    }

    if (item.kind === "term" && low && item.atSec !== undefined) {
        return {
            kind: "question",
            status: "suggested",
            about: "term",
            fromSec: item.atSec,
            toSec: item.atSec + TERM_CLIP_SEC,
            question: `Is "${item.heard}" at ${formatClock(item.atSec)} really "${item.proposed}"?`,
            heard: item.heard,
            choices: [item.proposed],
            decides: [item.id],
            rules: item.rules,
            ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
        };
    }

    return undefined;
}

/** Two questions are the same when they ask about the same range for the same items. */
export function questionKey(item: Pick<QuestionItem, "about" | "fromSec" | "toSec" | "decides">): string {
    return `question|${item.about}|${Math.round(item.fromSec)}|${Math.round(item.toSec)}|${item.decides.join(",")}`;
}

/** The open questions in transcript order. */
export function openQuestions(record: MeetingRecord): QuestionItem[] {
    return record.items
        .filter((item): item is QuestionItem => item.kind === "question" && item.status === "suggested")
        .sort((a, b) => a.fromSec - b.fromSec);
}

/**
 * Writes an answer into the record: the question is confirmed, and each item it decides is confirmed with the answer
 * (a range's speaker, a term's spelling, a join's speaker) or rejected when the answer is "none of these". Returns
 * the confirmed term corrections for the ledger. Mutates `record`.
 */
export function answerQuestion(
    record: MeetingRecord,
    id: string,
    options: { answer: string; comment?: string; now: string }
): Correction[] {
    const question = record.items.find((item): item is QuestionItem => item.id === id && item.kind === "question");

    if (!question) {
        throw new Error(`${record.id} has no question ${id}`);
    }

    const answer = options.answer.trim();
    const none = answer.toLowerCase() === NONE_OF_THESE;
    question.status = "confirmed";
    question.answer = answer;
    question.decidedAt = options.now;

    if (options.comment?.trim()) {
        question.comment = options.comment.trim();
    }

    const ledger: Correction[] = [];

    for (const item of record.items) {
        if (!question.decides.includes(item.id) || item.kind === "question") {
            continue;
        }

        item.decidedAt = options.now;

        if (none) {
            item.status = "rejected";
            continue;
        }

        item.status = "confirmed";

        if (item.kind === "speaker-range" || item.kind === "join") {
            item.speaker = answer;
        }

        if (item.kind === "term") {
            item.proposed = answer;
            ledger.push({
                at: options.now,
                meeting: record.id,
                project: record.project,
                kind: "term",
                heard: item.heard,
                fixed: answer,
                item: item.id,
            });
        }
    }

    return ledger;
}

/** A skipped question is rejected; the items it decides stay as they were. Mutates `record`. */
export function skipQuestion(record: MeetingRecord, id: string, now: string): void {
    const question = record.items.find((item) => item.id === id && item.kind === "question");

    if (!question) {
        throw new Error(`${record.id} has no question ${id}`);
    }

    question.status = "rejected";
    question.decidedAt = now;
}

/** The names and words an answer may be: the attendees, the participants, the calendar and the dictionary. */
export function answerVocabulary(record: MeetingRecord, dictionaryValues: string[]): string[] {
    return [
        ...new Set([
            ...(record.attendance?.people.map((person) => person.name) ?? []),
            ...record.participants.map((person) => person.name),
            ...(record.calendar?.attendees ?? []),
            ...dictionaryValues,
        ]),
    ].filter((value) => value.trim().length > 0);
}
