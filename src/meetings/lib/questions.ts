import type { Correction } from "@genesiscz/utils/meetings/corrections";
import { voiceRuns } from "@genesiscz/utils/meetings/energy";
import { type MeetingItem, type MeetingRecord, meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { importanceOf } from "@genesiscz/utils/transcribe/importance";
import {
    type HeardContext,
    type HeardOccurrence,
    LAST_LINE_SEC,
    TranscriptLines,
} from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import { citesPoint, keyWords, type SummaryPoint } from "@genesiscz/utils/transcribe/summary";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { ledgerEntryFor } from "./transcript-corrections";

export type { HeardContext } from "@genesiscz/utils/transcribe/lines";

/** The answer that rejects every item a question decides. */
export const NONE_OF_THESE = "none of these";

export type QuestionItem = Extract<MeetingItem, { kind: "question" }>;
export type NewQuestion = Omit<QuestionItem, "id" | "suggestedAt">;
type RangeItem = Extract<MeetingItem, { kind: "speaker-range" }>;

/** Items below this confidence are asked by ear, unless the config sets `global.suggest.listenBelow`. */
export const DEFAULT_LISTEN_BELOW = 0.6;

/** A term question hears this much after the word's line starts. */
const TERM_CLIP_SEC = 4;
/** A range with this many words or fewer never matters enough to ask. */
const TOO_SHORT_WORDS = 5;
/** Below this many words a range is asked only when it holds a decision or an action word. */
const ENOUGH_WORDS = 15;
/** Impact added by a decision or action word, a cited summary point, and an answer that moves an action's owner. */
const IMPACT = { decision: 3, cited: 3, owner: 2 } as const;

/** What a question needs to know about the meeting besides the item. */
export interface QuestionContext {
    listenBelow: number;
    /** Who was in the call, the user under their own name (`CallTimeline.named`, as `OpenedMeeting.presence` gives it). */
    presence?: Presence[];
    /** The source's transcript, on the source's own labels. */
    transcript: TranscriptEntry[];
    /** The summary's action items and decisions. */
    points: SummaryPoint[];
}

const linesCache = new WeakMap<readonly TranscriptEntry[], TranscriptLines>();

/** The transcript as addressed lines, built once per transcript array. */
function linesOf(transcript: readonly TranscriptEntry[] | TranscriptLines): TranscriptLines {
    if (transcript instanceof TranscriptLines) {
        return transcript;
    }

    const cached = linesCache.get(transcript);

    if (cached) {
        return cached;
    }

    const lines = new TranscriptLines(transcript);
    linesCache.set(transcript, lines);
    return lines;
}

/** The lines of a label from `fromSec` to `toSec`, each with its end (`TranscriptLines.end`). */
function rangeLines(context: QuestionContext, label: string, fromSec: number, toSec: number) {
    const lines = linesOf(context.transcript);
    return context.transcript.flatMap((entry, index) =>
        entry.startSec !== undefined && entry.speaker === label && entry.startSec >= fromSec && entry.startSec <= toSec
            ? [
                  {
                      startSec: entry.startSec,
                      endSec: lines.end(index) ?? entry.startSec + LAST_LINE_SEC,
                      text: entry.text,
                  },
              ]
            : []
    );
}

/** How much the answer changes: the words at stake, decisions, cited summary points, and an action's owner. */
function impactOf(text: string, label: string, context: QuestionContext): { impact: number; decision: boolean } {
    const importance = importanceOf(text);
    const words = new Set(keyWords(text));
    const cited = context.points.filter((point) => citesPoint(words, point));
    const ownerMoves = cited.some((point) => point.kind === "action" && point.person && !sameName(point.person, label));
    const impact =
        Math.log2(1 + importance.words) +
        (importance.decision ? IMPACT.decision : 0) +
        (cited.length > 0 ? IMPACT.cited : 0) +
        (ownerMoves ? IMPACT.owner : 0);
    return { impact: Math.round(impact * 100) / 100, decision: importance.decision || cited.length > 0 };
}

/**
 * The question a suggested item needs before anyone confirms it, or nothing when it is not worth a person's time
 * (Martin, 2026-11-02: "just on those which are really important and not sure of"):
 * - a speaker range under `listenBelow` with more than 5 words that are not all fillers, and 15 words or a decision;
 * - a term under `listenBelow` whose time is known and that is seen twice, looks like an identifier, is a person's
 *   name from the summary, or sits in a line with a decision.
 * The question carries its impact and signature in `evidence`; `selectQuestions` clusters and ranks them.
 */
export function questionFor(item: MeetingItem, context: QuestionContext): NewQuestion | undefined {
    const low =
        item.evidence?.listen === true || (item.confidence !== undefined && item.confidence < context.listenBelow);

    // A goodbye nobody answered (R1/R5 without R13 or R14) may be only an intention: kept, never asked by ear.
    if (item.status !== "suggested" || !low || item.evidence?.intention === true) {
        return undefined;
    }

    if (item.kind === "speaker-range") {
        // A range ends where its last line starts; the clip must hear that line to its end.
        const lineEnd = item.evidence?.endSec;
        const toSec = typeof lineEnd === "number" ? Math.max(item.toSec, lineEnd) : item.toSec;
        const lines = rangeLines(context, item.label, item.fromSec, item.toSec);
        const text = lines.map((line) => line.text).join(" ");
        const importance = importanceOf(text);

        if (
            lines.length > 0 &&
            (importance.words <= TOO_SHORT_WORDS ||
                importance.fillersOnly ||
                (importance.words < ENOUGH_WORDS && !impactOf(text, item.label, context).decision))
        ) {
            return undefined;
        }

        const present = (context.presence ?? [])
            .filter((stay) => stay.fromSec <= toSec && stay.toSec >= item.fromSec)
            .map((stay) => stay.name);
        const choices = [...new Set([...(item.speaker ? [item.speaker] : []), ...(item.candidates ?? []), ...present])];
        const { impact } = impactOf(text, item.label, context);
        const longest = [...lines].sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec))[0];
        return {
            kind: "question",
            status: "suggested",
            about: "speaker",
            fromSec: item.fromSec,
            toSec,
            question: `Who speaks under "${item.label}" from ${formatClock(item.fromSec)} to ${formatClock(toSec)}?`,
            choices,
            decides: [item.id],
            rules: item.rules,
            ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
            ...(longest ? { clip: { fromSec: longest.startSec, toSec: longest.endSec } } : {}),
            signature: `${choices.slice(0, 2).sort().join("+")}|${[...new Set(present)].sort().join(",")}`,
            evidence: { words: importance.words, impact, labels: [item.label] },
        };
    }

    if (item.kind === "term" && item.atSec !== undefined) {
        const occurrences = typeof item.evidence?.occurrences === "number" ? item.evidence.occurrences : 1;
        const identifier = /\p{Lu}.*\p{Lu}|\d|[_./]/u.test(item.proposed ?? item.heard);
        const atLine = context.transcript.find(
            (entry) => entry.startSec !== undefined && Math.abs(entry.startSec - item.atSec!) < 1
        );
        const decision = atLine ? importanceOf(atLine.text).decision : false;
        const personName = item.rules.includes(MeetingRule.SummaryName);

        if (occurrences < 2 && !identifier && !decision && !personName) {
            return undefined;
        }

        const lines = linesOf(context.transcript);
        const said = lines.heardLine({ heard: item.heard, fromSec: item.atSec, toSec: item.atSec });
        const clip = said ? lines.clip(said) : undefined;

        return {
            kind: "question",
            status: "suggested",
            about: "term",
            fromSec: item.atSec,
            toSec: item.atSec + TERM_CLIP_SEC,
            // No proposal: no layer knows the word and no term resembles it, so the listener types it.
            question: item.proposed
                ? `Is "${item.heard}" at ${formatClock(item.atSec)} really "${item.proposed}"?`
                : `What is "${item.heard}" at ${formatClock(item.atSec)}?`,
            heard: item.heard,
            choices: item.proposed ? [item.proposed] : [],
            decides: [item.id],
            rules: item.rules,
            ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
            ...(clip ? { clip } : {}),
            signature: `term|${item.heard.toLowerCase()}`,
            evidence: {
                impact: Math.log2(1 + occurrences) + (decision ? IMPACT.decision : 0) + (personName ? IMPACT.owner : 0),
                occurrences,
            },
        };
    }

    return undefined;
}

/** Two questions are the same when they ask about the same range for the same items. */
export function questionKey(item: Pick<QuestionItem, "about" | "fromSec" | "toSec" | "decides">): string {
    return `question|${item.about}|${Math.round(item.fromSec)}|${Math.round(item.toSec)}|${item.decides.join(",")}`;
}

/** The open questions, the most valuable first (priority), then in transcript order. */
export function openQuestions(record: MeetingRecord): QuestionItem[] {
    return record.items
        .filter((item): item is QuestionItem => item.kind === "question" && item.status === "suggested")
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.fromSec - b.fromSec);
}

/** An answer raises the items of every question with the same signature by this much, up to `PROPAGATED_MAX`. */
const PROPAGATED_BONUS = 0.3;
const PROPAGATED_MAX = 0.9;

/**
 * One answer settles its look-alikes: every open speaker question with the same signature (the same top choices and
 * the same people present) that offers the answer gets it on its items, +0.3 up to 0.9. A question that reaches
 * `listenBelow` is closed as settled; the others stay, scored higher. Returns the questions it closed. Mutates `record`.
 */
export function propagateAnswer(
    record: MeetingRecord,
    answered: QuestionItem,
    options: { answer: string; listenBelow: number; now: string }
): string[] {
    if (answered.about !== "speaker" || !answered.signature || options.answer.toLowerCase() === NONE_OF_THESE) {
        return [];
    }

    const settled: string[] = [];

    for (const question of openQuestions(record)) {
        const offers = question.choices.some((choice) => sameName(choice, options.answer));

        if (question.id === answered.id || question.signature !== answered.signature || !offers) {
            continue;
        }

        let lowest = 1;

        for (const item of record.items) {
            if (item.kind !== "speaker-range" || !question.decides.includes(item.id)) {
                continue;
            }

            item.speaker = options.answer;
            item.confidence = Math.min(
                PROPAGATED_MAX,
                Math.round(((item.confidence ?? 0) + PROPAGATED_BONUS) * 100) / 100
            );
            item.rules = [...new Set([...item.rules, MeetingRule.User])];
            lowest = Math.min(lowest, item.confidence);
        }

        question.confidence = lowest;

        if (lowest >= options.listenBelow) {
            question.status = "rejected";
            question.decidedAt = options.now;
            question.comment = `settled by the answer to ${answered.id}`;
            settled.push(question.id);
        }
    }

    return settled;
}

/** A line shorter than this is one voice; a longer one is cut where the voice moves between the channels. */
const SPLIT_LINE_MIN_SEC = 3;

/** The words of a part of a line, by its place in the line's time: the transcript has no time per word. */
function partWords(text: string, line: { fromSec: number; toSec: number }, part: { fromSec: number; toSec: number }) {
    const words = text.split(/\s+/).filter(Boolean);
    const span = Math.max(0.001, line.toSec - line.fromSec);
    const from = Math.round((words.length * (part.fromSec - line.fromSec)) / span);
    const to = Math.round((words.length * (part.toSec - line.fromSec)) / span);
    return words.slice(from, Math.max(from + 1, to)).join(" ");
}

const SIDE_HINT = { mic: ", on your microphone", call: ", from the call", mixed: "" } as const;

/**
 * "Several voices": the question is cut into one question per line inside it, and a long line also where the voice
 * moves between the microphone and the call (`micShare`). Each part shows its words and plays only its own audio.
 * A part that is a whole line of a range the question decides gets its own range. The question and its ranges are
 * rejected only when there are two parts or more; otherwise nothing changes and no question is returned.
 * Mutates `record`.
 */
export function splitQuestion(
    record: MeetingRecord,
    id: string,
    options: {
        transcript: TranscriptEntry[];
        now: string;
        micShare?: (fromSec: number, toSec: number) => number | undefined;
    }
): QuestionItem[] {
    const question = record.items.find((item): item is QuestionItem => item.id === id && item.kind === "question");

    if (!question) {
        throw new Error(`${record.id} has no question ${id}`);
    }

    const addressed = linesOf(options.transcript);
    const lastTimed = options.transcript.findLastIndex((entry) => entry.startSec !== undefined);
    const ranges = record.items.filter(
        (item): item is RangeItem => item.kind === "speaker-range" && question.decides.includes(item.id)
    );
    const inQuestion = (startSec: number) =>
        startSec >= question.fromSec - 0.5 && (startSec < question.toSec || startSec === question.fromSec);
    const lines = options.transcript.flatMap((entry, index) => {
        const startSec = entry.startSec;

        if (startSec === undefined) {
            return [];
        }

        const range = ranges.find(
            (candidate) =>
                entry.speaker === candidate.label && startSec >= candidate.fromSec && startSec <= candidate.toSec
        );

        if (ranges.length > 0 ? !range : !inQuestion(startSec)) {
            return [];
        }

        const end = addressed.end(index) ?? startSec + LAST_LINE_SEC;
        // The transcript's last line has no next start: it lasts at least to the question's end.
        const next = index >= lastTimed ? Math.max(end, question.toSec) : end;
        const toSec = range || question.toSec <= startSec ? next : Math.min(next, question.toSec);
        return [{ entry, range, fromSec: startSec, toSec }];
    });
    const parts = lines.flatMap((line) => {
        const runs =
            options.micShare && line.toSec - line.fromSec >= SPLIT_LINE_MIN_SEC
                ? voiceRuns(options.micShare, line.fromSec, line.toSec)
                : [];
        return runs.length > 1
            ? runs.map((run) => ({ line, run, whole: false }))
            : [{ line, run: { fromSec: line.fromSec, toSec: line.toSec, side: "mixed" as const }, whole: true }];
    });

    if (parts.length < 2) {
        return [];
    }

    const created: QuestionItem[] = [];

    for (const range of ranges) {
        if (parts.some((part) => part.line.range === range && !part.whole)) {
            continue;
        }

        range.status = "rejected";
        range.decidedAt = options.now;
    }

    for (const { line, run, whole } of parts) {
        const words = whole ? line.entry.text : partWords(line.entry.text, line, run);
        const decided =
            whole && line.range
                ? meetingItemSchema.parse({
                      ...line.range,
                      id: nextId("i", record.items),
                      status: "suggested",
                      fromSec: line.fromSec,
                      toSec: line.fromSec,
                      evidence: { ...line.range.evidence, endSec: line.toSec, splitFrom: line.range.id },
                      suggestedAt: options.now,
                      decidedAt: undefined,
                  })
                : undefined;

        if (decided) {
            record.items.push(decided);
        }

        const asked = meetingItemSchema.parse({
            ...question,
            id: nextId("i", record.items),
            status: "suggested",
            fromSec: run.fromSec,
            toSec: run.toSec,
            question: `Who says "${words.length > 120 ? `${words.slice(0, 120)}…` : words}" (${formatClock(run.fromSec)} to ${formatClock(run.toSec)}${SIDE_HINT[run.side]})?`,
            decides: decided ? [decided.id] : [],
            answer: undefined,
            comment: undefined,
            clip: undefined,
            signature: undefined,
            suggestedAt: options.now,
            decidedAt: undefined,
        });
        record.items.push(asked);

        if (asked.kind === "question") {
            created.push(asked);
        }
    }

    question.status = "rejected";
    question.decidedAt = options.now;
    question.comment = `split into ${created.length} parts, one per line and voice`;
    return created;
}

/**
 * Writes an answer into the record: the question is confirmed, and each item it decides is confirmed with the answer
 * (a range's speaker, a term's spelling, a join's speaker) or rejected when the answer is "none of these". Returns
 * the confirmed term and join corrections for the ledger. Mutates `record`.
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
        }

        const entry = ledgerEntryFor(record, item, options.now);

        if (entry) {
            ledger.push(entry);
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

/** The `occurrence`-th whole-word occurrence of a word question's heard words in its range. */
function heardLine(question: QuestionItem, lines: TranscriptLines, occurrence: number): HeardOccurrence | undefined {
    if (!question.heard) {
        return undefined;
    }

    return lines.heardLine({ heard: question.heard, fromSec: question.fromSec, toSec: question.toSec }, occurrence);
}

/**
 * Which occurrence of its heard words a question asks about: questions on the same words over the same range take
 * them in the order they were added, so two occurrences in one line get their own time and context.
 */
export function questionOccurrence(record: MeetingRecord, question: QuestionItem): number {
    const heard = heardKey(question);

    if (!heard) {
        return 0;
    }

    const twins = record.items.filter(
        (item): item is QuestionItem =>
            item.kind === "question" &&
            heardKey(item) === heard &&
            Math.round(item.fromSec) === Math.round(question.fromSec) &&
            Math.round(item.toSec) === Math.round(question.toSec)
    );
    return Math.max(
        0,
        twins.findIndex((item) => item.id === question.id)
    );
}

/**
 * The moment in the recording the question is about: for a term or text, where its heard words fall, estimated from
 * their place in the line (a source times lines, not words); for a speaker, or words not found, the range's start.
 */
export function askedSpotSec(
    question: QuestionItem,
    transcript: readonly TranscriptEntry[] | TranscriptLines,
    occurrence = 0
): number {
    const lines = linesOf(transcript);
    const found = heardLine(question, lines, occurrence);
    return (found ? lines.spotSec(found) : undefined) ?? question.fromSec;
}

/** The audio a word question plays: shortly before to shortly after the spot of its heard words; none when not found. */
export function heardClip(
    question: QuestionItem,
    transcript: readonly TranscriptEntry[] | TranscriptLines,
    occurrence = 0
): { fromSec: number; toSec: number } | undefined {
    const lines = linesOf(transcript);
    const found = heardLine(question, lines, occurrence);
    return found ? lines.clip(found) : undefined;
}

/** Where a word question's heard words are said: the sentence around them, so two questions on one word differ. */
export function heardContext(
    question: QuestionItem,
    transcript: readonly TranscriptEntry[] | TranscriptLines,
    maxChars: number,
    occurrence = 0
): HeardContext | undefined {
    const lines = linesOf(transcript);
    const found = heardLine(question, lines, occurrence);
    return found ? lines.context(found, maxChars) : undefined;
}

/**
 * A question's number for people: `Q3` is the record's third question, in the order the questions were added. A
 * polished transcript numbers its open questions the same way, so "Q3 b)" names one question in both.
 */
export function questionNumber(record: MeetingRecord, id: string): number {
    return record.items.filter((item) => item.kind === "question").findIndex((item) => item.id === id) + 1;
}

/** How a person names a question: `Q<n>`, the number the polished file and the listen header use, else its id. */
export function questionLabel(record: MeetingRecord, id: string): string {
    const n = questionNumber(record, id);
    return n > 0 ? `Q${n}` : id;
}

/** The item id a person's reference names: `Q12`, `12` or the id itself (`i42`). Unknown numbers stay as given. */
export function questionIdOf(record: MeetingRecord, ref: string): string {
    const n = /^q?(\d+)$/i.exec(ref.trim())?.[1];

    if (!n) {
        return ref;
    }

    return record.items.filter((item) => item.kind === "question")[Number(n) - 1]?.id ?? ref;
}

/** The words of the lines a speaker question asks about; a split part names its own words in the question. */
function spokenIn(
    question: QuestionItem,
    transcript: readonly TranscriptEntry[] | TranscriptLines,
    maxChars: number
): string | undefined {
    if (question.question.startsWith('Who says "')) {
        return undefined;
    }

    const text = linesOf(transcript)
        .entries.filter(
            (entry) =>
                entry.startSec !== undefined &&
                entry.startSec >= question.fromSec - 0.5 &&
                (entry.startSec < question.toSec || entry.startSec === question.fromSec)
        )
        .map((entry) => entry.text)
        .join(" ");
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text || undefined;
}

/** What a person sees of a question, before any styling: its name, its time, and the words it asks about. */
export interface QuestionView {
    /** `Q12`. */
    label: string;
    question: string;
    /** `59:48–1:00:13`. */
    range: string;
    priority?: number;
    /** A word question: its line, with the heard words marked, and the lines around it. */
    context?: HeardContext;
    /** A speaker question: what is said in the asked span. */
    said?: string;
}

/** The one place that composes what a person sees of a question; the terminal and `items` only paint it. */
export function questionView(
    record: MeetingRecord,
    question: QuestionItem,
    transcript: readonly TranscriptEntry[] | TranscriptLines,
    maxChars: number
): QuestionView {
    const context =
        question.about === "speaker"
            ? undefined
            : heardContext(question, transcript, maxChars, questionOccurrence(record, question));
    const said = question.about === "speaker" ? spokenIn(question, transcript, maxChars) : undefined;
    return {
        label: questionLabel(record, question.id),
        question: question.question,
        range: `${formatClock(question.fromSec)}–${formatClock(question.toSec)}`,
        ...(question.priority === undefined ? {} : { priority: question.priority }),
        ...(context ? { context } : {}),
        ...(said ? { said } : {}),
    };
}

function heardKey(question: QuestionItem): string | undefined {
    const heard = question.heard?.trim().toLocaleLowerCase();
    return heard || undefined;
}

/**
 * One answer settles its look-alikes. A speaker answer raises the questions with its signature (`propagateAnswer`).
 * A word answer answers every other open word question on the same heard words the same way, so the same word is not
 * asked twice; each is marked "settled by the answer to iN". "None of these" settles nothing. Mutates `record`.
 */
export function settleLookAlikes(
    record: MeetingRecord,
    answered: QuestionItem,
    options: { answer: string; listenBelow: number; now: string }
): { settled: string[]; corrections: Correction[] } {
    if (answered.about === "speaker") {
        return { settled: propagateAnswer(record, answered, options), corrections: [] };
    }

    const heard = heardKey(answered);

    if (!heard || options.answer.trim().toLowerCase() === NONE_OF_THESE) {
        return { settled: [], corrections: [] };
    }

    const settled: string[] = [];
    const corrections: Correction[] = [];

    for (const question of openQuestions(record)) {
        if (question.id === answered.id || question.about === "speaker" || heardKey(question) !== heard) {
            continue;
        }

        corrections.push(
            ...answerQuestion(record, question.id, {
                answer: options.answer,
                comment: `settled by the answer to ${answered.id}`,
                now: options.now,
            })
        );
        settled.push(question.id);
    }

    return { settled, corrections };
}

/**
 * What `items add` warns about in new questions: text that repeats another open question (the listener cannot tell
 * them apart), a question that decides no item, and one with no priority (it is asked last).
 */
export function questionWarnings(record: MeetingRecord, added: MeetingItem[]): string[] {
    const open = openQuestions(record);
    const warnings: string[] = [];

    for (const question of added) {
        if (question.kind !== "question") {
            continue;
        }

        const label = questionLabel(record, question.id);
        const text = question.question.trim().toLocaleLowerCase();
        const twin = open.find(
            (other) => other.id !== question.id && other.question.trim().toLocaleLowerCase() === text
        );

        if (twin) {
            warnings.push(
                `${label} asks the same as ${questionLabel(record, twin.id)} ("${question.question}"): name the time or the words, so the listener can tell them apart.`
            );
        }

        if (question.decides.length === 0) {
            warnings.push(`${label} decides no item: its answer changes nothing in the transcript (--decides <ids>).`);
        }

        if (question.priority === undefined) {
            warnings.push(
                `${label} has no priority, so listen asks it after every question that has one (--priority <n>, the scale suggest uses: about 1 to 3).`
            );
        }
    }

    return warnings;
}
