import type { Correction } from "@genesiscz/utils/meetings/corrections";
import { voiceRuns } from "@genesiscz/utils/meetings/energy";
import { type MeetingItem, type MeetingRecord, meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { importanceOf } from "@genesiscz/utils/transcribe/importance";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import { citesPoint, keyWords, type SummaryPoint } from "@genesiscz/utils/transcribe/summary";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";

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
    presence?: Presence[];
    /** The user's own name: an attendance stay marked `self` (Teams names it by email) is shown as this. */
    selfName?: string;
    /** The source's transcript, on the source's own labels. */
    transcript: TranscriptEntry[];
    /** The summary's action items and decisions. */
    points: SummaryPoint[];
}

/** The lines of a label from `fromSec` to `toSec`, each with its end (the next line's start). */
function rangeLines(context: QuestionContext, label: string, fromSec: number, toSec: number) {
    const timed = context.transcript.filter((entry) => entry.startSec !== undefined);
    return timed.flatMap((entry, index) =>
        entry.speaker === label && entry.startSec! >= fromSec && entry.startSec! <= toSec
            ? [
                  {
                      startSec: entry.startSec!,
                      endSec: timed[index + 1]?.startSec ?? entry.startSec! + 5,
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
            .map((stay) => (stay.self && context.selfName ? context.selfName : stay.name));
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

    const labels = answered.evidence?.labels;
    if (!Array.isArray(labels) || labels.length !== 1) {
        return [];
    }

    const settled: string[] = [];

    for (const question of openQuestions(record)) {
        const offers = question.choices.some((choice) => sameName(choice, options.answer));

        const otherLabels = question.evidence?.labels;
        if (
            question.id === answered.id ||
            question.signature !== answered.signature ||
            !offers ||
            question.fromSec !== answered.fromSec ||
            question.toSec !== answered.toSec ||
            !Array.isArray(otherLabels) ||
            otherLabels.length !== 1 ||
            otherLabels[0] !== labels[0]
        ) {
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

    const timed = options.transcript.filter((entry) => entry.startSec !== undefined);
    const ranges = record.items.filter(
        (item): item is RangeItem => item.kind === "speaker-range" && question.decides.includes(item.id)
    );
    const inQuestion = (startSec: number) =>
        startSec >= question.fromSec - 0.5 && (startSec < question.toSec || startSec === question.fromSec);
    const lines = timed.flatMap((entry, index) => {
        const startSec = entry.startSec!;
        const range = ranges.find(
            (candidate) =>
                entry.speaker === candidate.label && startSec >= candidate.fromSec && startSec <= candidate.toSec
        );

        if (ranges.length > 0 ? !range : !inQuestion(startSec)) {
            return [];
        }

        const next = timed[index + 1]?.startSec ?? Math.max(startSec + 5, question.toSec);
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
                scope: item.scope ?? "everywhere",
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

/** The transcript line inside the question's range that holds its heard words, and where they start in it. */
function heardLine(question: QuestionItem, transcript: TranscriptEntry[]): { n: number; at: number } | undefined {
    const heard = question.heard?.toLowerCase();

    if (!heard) {
        return undefined;
    }

    for (const [n, line] of transcript.entries()) {
        const startSec = line.startSec;

        if (startSec === undefined || startSec < question.fromSec - 1 || startSec > question.toSec) {
            continue;
        }

        const at = line.text.toLowerCase().indexOf(heard);

        if (at >= 0) {
            return { n, at };
        }
    }

    return undefined;
}

/**
 * The moment in the recording the question is about: for a term or text, where its heard words fall, estimated from
 * their place in the line (a source times lines, not words); for a speaker, or words not found, the range's start.
 */
export function askedSpotSec(question: QuestionItem, transcript: TranscriptEntry[]): number {
    const found = heardLine(question, transcript);
    const startSec = found ? transcript[found.n]!.startSec : undefined;

    if (!found || startSec === undefined) {
        return question.fromSec;
    }

    const line = transcript[found.n]!;
    const endSec =
        transcript.slice(found.n + 1).find((next) => next.startSec !== undefined)?.startSec ?? question.toSec;
    return startSec + (found.at / Math.max(1, line.text.length)) * Math.max(0, endSec - startSec);
}

/** The words of a heard passage in its line, with the line before and after, each cut to about `maxChars`. */
export interface HeardContext {
    before?: string;
    /** The line's text up to the heard words, the heard words as the transcript has them, and the rest of the line. */
    lead: string;
    heard: string;
    rest: string;
    after?: string;
}

/** Where a word question's heard words are said: the sentence around them, so two questions on one word differ. */
export function heardContext(
    question: QuestionItem,
    transcript: TranscriptEntry[],
    maxChars: number
): HeardContext | undefined {
    const found = heardLine(question, transcript);

    if (!found) {
        return undefined;
    }

    const text = transcript[found.n]!.text;
    const end = found.at + (question.heard?.length ?? 0);
    const side = Math.max(20, Math.floor((maxChars - (end - found.at)) / 2));
    const lead =
        found.at > side ? `…${text.slice(found.at - side, found.at).replace(/^\S*\s/, "")}` : text.slice(0, found.at);
    const rest = text.length - end > side ? `${text.slice(end, end + side).replace(/\s\S*$/, "")}…` : text.slice(end);
    const neighbour = (step: -1 | 1): string | undefined => {
        const line = transcript[found.n + step];

        if (!line?.text.trim()) {
            return undefined;
        }

        const words = line.text.trim();

        if (words.length <= maxChars) {
            return words;
        }

        return step < 0
            ? `…${words.slice(-maxChars).replace(/^\S*\s/, "")}`
            : `${words.slice(0, maxChars).replace(/\s\S*$/, "")}…`;
    };
    const before = neighbour(-1);
    const after = neighbour(1);
    return {
        ...(before ? { before } : {}),
        lead,
        heard: text.slice(found.at, end),
        rest,
        ...(after ? { after } : {}),
    };
}

/**
 * A question's number for people: `Q3` is the record's third question, in the order the questions were added. A
 * polished transcript numbers its open questions the same way, so "Q3 b)" names one question in both.
 */
export function questionNumber(record: MeetingRecord, id: string): number {
    return record.items.filter((item) => item.kind === "question").findIndex((item) => item.id === id) + 1;
}
