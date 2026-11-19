import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { presentAt } from "@genesiscz/utils/transcribe/evidence";
import { importanceOf } from "@genesiscz/utils/transcribe/importance";
import {
    type HeardContext,
    type HeardOccurrence,
    LAST_LINE_SEC,
    TranscriptLines,
} from "@genesiscz/utils/transcribe/lines";
import { formatClock, voiceNameText } from "@genesiscz/utils/transcribe/render";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import { citesPoint, keyWords, type SummaryPoint } from "@genesiscz/utils/transcribe/summary";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import type { MutedCallLines } from "./call-mutes";
import type { LineSpeakers } from "./speaker-evidence";
import { needsSpeakerReview, speakerScoresOf } from "./speaker-scores";

export type { HeardContext } from "@genesiscz/utils/transcribe/lines";
export * from "./question-answers";

/** The answer that rejects every item a question decides. */
export const NONE_OF_THESE = "none of these";

export type QuestionItem = Extract<MeetingItem, { kind: "question" }>;
export type NewQuestion = Omit<QuestionItem, "id" | "suggestedAt">;
/** A prepared stretch keeps the lowest confidence of its lines. An older unscored question stays reviewable. */
export function withinListenThreshold(question: QuestionItem, applyAbove: number | undefined): boolean {
    return (
        question.group !== "long-stretch" ||
        applyAbove === undefined ||
        question.confidence === undefined ||
        question.confidence < applyAbove
    );
}

export type RangeItem = Extract<MeetingItem, { kind: "speaker-range" }>;

/** Items below this confidence are asked by ear, unless the config sets `global.suggest.listenBelow`. */
export const DEFAULT_LISTEN_BELOW = 0.6;

/** A term question hears this much after the word's line starts. */
export const TERM_CLIP_SEC = 4;
/** A range with this many words or fewer never matters enough to ask. */
const TOO_SHORT_WORDS = 5;
/** Below this many words a range is asked only when it holds a decision or an action word. */
const ENOUGH_WORDS = 15;
/** Impact added by a decision or action word, a cited summary point, and an answer that moves an action's owner. */
const IMPACT = { decision: 3, cited: 3, owner: 2 } as const;

/** What a question needs to know about the meeting besides the item. */
export interface QuestionContext {
    listenBelow: number;
    callMutes?: MutedCallLines;
    speakers?: LineSpeakers;
    /** Canonical candidate names from the meeting roster and people added to this meeting. */
    candidates?: readonly string[];
    /** Who was in the call, the user under their own name (`CallTimeline.named`, as `OpenedMeeting.presence` gives it). */
    presence?: Presence[];
    /** The source's transcript, on the source's own labels. */
    transcript: TranscriptEntry[];
    /** The summary's action items and decisions. */
    points: SummaryPoint[];
}

const linesCache = new WeakMap<readonly TranscriptEntry[], TranscriptLines>();

/** The transcript as addressed lines, built once per transcript array. */
export function linesOf(transcript: readonly TranscriptEntry[] | TranscriptLines): TranscriptLines {
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

const itemIndexes = new WeakMap<readonly MeetingItem[], Map<string, number>>();

/**
 * The items of `record` that `ids` name, in the record's order, through an id index kept per items array, so rendering
 * a batch of questions does not scan every item for each one. A position that no longer holds its id rebuilds it.
 */
export function itemsNamed(record: MeetingRecord, ids: readonly string[]): MeetingItem[] {
    const items = record.items;
    const build = () => {
        const index = new Map(items.map((item, at) => [item.id, at]));
        itemIndexes.set(items, index);
        return index;
    };
    let index = itemIndexes.get(items) ?? build();

    const found = new Set<number>();

    for (const id of ids) {
        let at = index.get(id);

        if (at === undefined || items[at]?.id !== id) {
            index = build();
            at = index.get(id);
        }

        if (at !== undefined) {
            found.add(at);
        }
    }

    return [...found].sort((a, b) => a - b).map((at) => items[at]!);
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

/** Where a capital needs no name to explain it: the start of a line, or after a sentence ends. */
const SENTENCE_END = /[.!?…:]["“”„»]?$/u;

/**
 * A capital that no sentence start explains: the word is a name or a product, so its spelling is worth a person's
 * time. A lowercase word that no layer knows is speech (a colloquial form, slang), and asking it spent the budget and
 * marked ordinary words as unclear in the transcript (R2-MC1).
 */
function capitalMidSentence(heard: string, transcript: readonly TranscriptEntry[]): boolean {
    if (!/^\p{Lu}/u.test(heard)) {
        return false;
    }

    const escaped = heard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu");
    return transcript.some((entry) =>
        [...entry.text.matchAll(pattern)].some((match) => {
            const before = entry.text.slice(0, match.index).trimEnd();
            return before.length > 0 && !SENTENCE_END.test(before);
        })
    );
}

/**
 * Who the presence places in the call at `atSec`, and who it knows of but places outside the call then. Every
 * speaker question offers only the first and never the second (I13: a person is offered only inside their window).
 */
export function presenceAt(presence: Presence[] | undefined, atSec: number): { present: string[]; absent: string[] } {
    const present = presentAt(presence ?? [], atSec);
    const absent = [...new Set((presence ?? []).map((stay) => stay.name))].filter(
        (name) => !present.some((other) => sameName(name, other))
    );
    return { present, absent };
}

function speakerChoices(
    names: readonly string[],
    allowed: string[] | undefined,
    excluded: readonly string[]
): string[] {
    return [...names, ...(allowed ?? [])].filter(
        (name, index, all) =>
            name &&
            (allowed
                ? allowed.some((other) => sameName(name, other))
                : !excluded.some((other) => sameName(name, other))) &&
            all.findIndex((other) => sameName(name, other)) === index
    );
}

/** Voice exclusions, stranger stretches and roster eliminations need a direct listen even on a short line. */
export function groupSpeakerQuestions(
    items: MeetingItem[],
    asked: Set<string>,
    context: QuestionContext
): NewQuestion[] {
    const groups: RangeItem[][] = [];
    let previousKey: string | undefined;
    for (const item of items) {
        if (item.kind !== "speaker-range" || item.status !== "suggested" || asked.has(item.id)) {
            continue;
        }
        const ev = item.evidence;
        const stretch = ev?.strangerStretch ?? ev?.exclusionStretch;
        if (typeof stretch !== "number" && ev?.reviewOnly !== true) {
            continue;
        }
        const indices = context.speakers?.linesFor(item).map((line) => line.index) ?? [];
        const key = [
            ev?.reason,
            stretch ?? item.id,
            ev?.exclusionPerson ?? ev?.seatPerson,
            ...new Set(indices.map((i) => context.speakers?.key(i))),
        ].join("|");
        if (key !== previousKey) {
            groups.push([]);
        }
        groups.at(-1)!.push(item);
        previousKey = key;
    }
    return groups.map((ranges) => {
        const first = ranges[0]!;
        const owner = first.evidence?.seatPerson;
        const person = first.evidence?.exclusionPerson ?? first.speaker ?? first.candidates?.[0];
        const stranger = first.evidence?.reason === "not-the-seat-person";
        const fromSec = Math.min(...ranges.map((r) => r.fromSec));
        const indices = ranges.flatMap((r) => context.speakers?.linesFor(r).map((line) => line.index) ?? []);
        const choices = speakerChoices(
            [
                ...(typeof person === "string" ? [person] : []),
                ...(typeof owner === "string" ? [owner] : []),
                ...ranges.flatMap((r) => r.candidates ?? []),
                ...(context.candidates ?? []),
            ],
            context.speakers?.choices(indices),
            presenceAt(context.presence, fromSec).absent
        );
        return {
            kind: "question",
            status: "suggested",
            about: "speaker",
            group: "rules",
            fromSec,
            toSec: Math.max(
                ...ranges.map((r) => (typeof r.evidence?.endSec === "number" ? r.evidence.endSec : r.toSec))
            ),
            question: stranger
                ? `This does not sound like ${owner}. Who is speaking?`
                : typeof person === "string"
                  ? `Is ${person} speaking here, or someone else?`
                  : "Who is speaking here?",
            choices,
            decides: ranges.map((r) => r.id),
            rules: first.rules,
            evidence: {
                reason: first.evidence?.reason,
                ...(stranger ? { seatPerson: owner } : { reviewOnly: true, margin: first.evidence?.margin }),
            },
        };
    });
}

/** Re-evaluate still-open generated questions when old targets split or acquire a different set of speakers. */
export function refreshSpeakerQuestions(items: MeetingItem[], context: QuestionContext) {
    const speakers = context.speakers;
    if (!speakers) {
        return;
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const question of items) {
        if (
            question.kind !== "question" ||
            question.about !== "speaker" ||
            question.status !== "suggested" ||
            question.decision ||
            question.rules.includes(MeetingRule.Agent) ||
            question.rules.includes(MeetingRule.User)
        ) {
            continue;
        }
        const ranges = question.decides.flatMap((id) => {
            const target = byId.get(id);
            return target?.kind === "speaker-range" ? [target] : [];
        });
        const indices = ranges.flatMap((r) => speakers.linesFor(r).map((row) => row.index));
        const allowed = speakers.choices(indices);
        if (!allowed) {
            continue;
        }
        if (
            ranges.some((r) => r.status === "rejected" && r.evidence?.retired) ||
            (new Set(indices.map((i) => speakers.key(i))).size > 1 && ranges.length > 1)
        ) {
            question.status = "rejected";
            question.evidence = { ...question.evidence, retired: "speaker-eligibility" };
            continue;
        }
        const choices = speakerChoices(question.choices, allowed, []);
        if (!Bun.deepEquals(choices, question.choices)) {
            question.choices = choices;
            delete question.signature;
        }
        if (indices.some((i) => speakers.unknownCall(i))) {
            delete question.signature;
        }
        if (ranges.some(needsSpeakerReview)) {
            delete question.signature;
            question.evidence = { ...question.evidence, reviewOnly: true };
        }
    }
}

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

        const { present, absent } = presenceAt(context.presence, item.fromSec);
        const excluded = [...absent, ...(context.callMutes?.forRange(item) ?? [])];
        // The people the range's typed scores weigh come last, so the first two choices (the signature) stay as before.
        const indices = context.speakers?.linesFor(item).map((line) => line.index) ?? [];
        const choices = speakerChoices(
            [
                ...(item.speaker ? [item.speaker] : []),
                ...(item.candidates ?? []),
                ...present,
                ...(context.candidates ?? []),
                ...speakerScoresOf(item).map((score) => score.speaker),
            ],
            context.speakers?.choices(indices),
            excluded
        );

        if (choices.length < 2) {
            return undefined;
        }
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
            // Missing indicator evidence never establishes a shared voice identity for propagation.
            signature:
                item.evidence?.sharedCallUnknown || indices.some((i) => context.speakers?.unknownCall(i))
                    ? undefined
                    : `${choices.slice(0, 2).sort().join("+")}|${[...new Set(present)].sort().join(",")}`,
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

        // A word no layer knows and nothing resembles is asked only as a code name, or as a name heard twice: a lone
        // colloquial form ("běžejí") in a decision line is speech (MC3), and so is a lowercase one heard often (R2-MC1).
        const unknownWord = item.rules.includes(MeetingRule.UnknownWord) && !item.proposed;
        const named = unknownWord && occurrences >= 2 && capitalMidSentence(item.heard, context.transcript);

        if (unknownWord ? !identifier && !named : occurrences < 2 && !identifier && !decision && !personName) {
            return undefined;
        }

        const heard = heardTerm(item, item.atSec, context);

        return {
            ...heard.question,
            // No proposal: no layer knows the word and no term resembles it, so the listener types it.
            question: item.proposed
                ? `Is "${item.heard}" at ${formatClock(item.atSec)} really "${item.proposed}"?`
                : `What is "${item.heard}" at ${formatClock(item.atSec)}?`,
            choices: item.proposed ? [item.proposed] : [],
            ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
            evidence: {
                impact: Math.log2(1 + occurrences) + (decision ? IMPACT.decision : 0) + (personName ? IMPACT.owner : 0),
                occurrences,
                ...heard.evidence,
            },
        };
    }

    return undefined;
}

type TermItem = Extract<MeetingItem, { kind: "term" }>;

/** The part of a term question that names the heard word: where it is said, the clip that plays it, its line. */
function heardTerm(item: TermItem, atSec: number, context: Pick<QuestionContext, "transcript">) {
    const lines = linesOf(context.transcript);
    const transcriptLine = item.evidence?.transcriptLine;
    const said = lines
        .occurrences({ heard: item.heard, fromSec: atSec, toSec: atSec })
        .find((one) => typeof transcriptLine !== "number" || one.index === transcriptLine);
    const clip = said ? lines.clip(said) : undefined;

    return {
        question: {
            kind: "question" as const,
            status: "suggested" as const,
            about: "term" as const,
            fromSec: atSec,
            toSec: atSec + TERM_CLIP_SEC,
            heard: item.heard,
            decides: [item.id],
            rules: item.rules,
            ...(clip ? { clip } : {}),
            signature: `term|${item.heard.toLowerCase()}`,
        },
        evidence: typeof transcriptLine === "number" ? { transcriptLine } : {},
    };
}

/** A word form heard this many times that no layer knows is asked in the group `words` (`global.suggest.words`). */
export const DEFAULT_WORD_MIN_OCCURRENCES = 2;

/** How many times an item's words are heard in the meeting (`evidence.occurrences`; 1 when it does not say). */
export function heardTimes(item: Pick<MeetingItem, "evidence">): number {
    const occurrences = item.evidence?.occurrences;
    return typeof occurrences === "number" ? occurrences : 1;
}

/** The priority filter uses three bands; listen orders words within them by their exact occurrence count. */
export function wordPriority(occurrences: number): number {
    if (occurrences >= 8) {
        return 3;
    }

    return occurrences >= 4 ? 2 : 1;
}

/**
 * One question of the group `words` per unknown word form heard `minOccurrences` times or more (the owner's answer to
 * M3): a suggested term with nothing proposed, a known time, and no question that decides it already. One answer
 * fixes every place the form is heard. The most heard come first; they stand outside the question budget.
 */
export function wordQuestions(items: MeetingItem[], context: QuestionContext, minOccurrences: number): NewQuestion[] {
    const asked = new Set(items.flatMap((item) => (item.kind === "question" ? item.decides : [])));
    // A form some question asks about through one of its terms is asked already.
    const askedForms = new Set(
        items.flatMap((item) => (item.kind === "term" && asked.has(item.id) ? [item.heard.toLowerCase()] : []))
    );
    const forms = new Map<string, Array<{ item: TermItem; atSec: number; occurrences: number }>>();

    for (const item of items) {
        if (
            item.kind !== "term" ||
            item.status !== "suggested" ||
            item.atSec === undefined ||
            item.proposed ||
            item.meaning ||
            item.quote ||
            !item.rules.includes(MeetingRule.UnknownWord) ||
            heardTimes(item) < minOccurrences ||
            askedForms.has(item.heard.toLowerCase())
        ) {
            continue;
        }

        const form = item.heard.toLowerCase();
        forms.set(form, [...(forms.get(form) ?? []), { item, atSec: item.atSec, occurrences: heardTimes(item) }]);
    }

    return [...forms.values()]
        .map((terms) => {
            const ordered = [...terms].sort((a, b) => a.atSec - b.atSec);
            return {
                ...ordered[0]!,
                occurrences: Math.max(...terms.map((term) => term.occurrences)),
                decides: ordered.map((term) => term.item.id),
            };
        })
        .sort((a, b) => b.occurrences - a.occurrences || a.atSec - b.atSec)
        .map(({ item, atSec, occurrences, decides }) => {
            const heard = heardTerm(item, atSec, context);
            return {
                ...heard.question,
                decides,
                group: "words" as const,
                question: `What is "${item.heard}"? It is heard ${occurrences} times.`,
                choices: [],
                ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
                priority: wordPriority(occurrences),
                evidence: { occurrences, impact: Math.log2(1 + occurrences), ...heard.evidence },
            };
        });
}

/** Two questions are the same when they ask about the same range for the same items. */
export function questionKey(item: Pick<QuestionItem, "about" | "fromSec" | "toSec" | "decides">): string {
    return `question|${item.about}|${Math.round(item.fromSec)}|${Math.round(item.toSec)}|${item.decides.join(",")}`;
}

/**
 * What a suggestion needs from a person before a confirm can take it: a speaker for a range nobody named, a spelling for
 * a term with no proposal, meaning or quote. `confirm` skips these, the window's bulk bar leaves them out
 * (`MeetingDetailModel.confirmable`), and the overview's count must agree with both (R2-MC13).
 */
export function inputNeeded(item: MeetingItem): "speaker" | "proposed" | undefined {
    if (item.kind === "speaker-range" && !item.speaker) {
        return "speaker";
    }

    if (item.kind === "term" && !item.proposed && !item.meaning && !item.quote) {
        return "proposed";
    }

    return undefined;
}

/** Order timed speaker questions by uncertain words and distinct answer targets; old questions retain their priority. */
export function questionRank(question: NewQuestion): number {
    const words = question.evidence?.words;

    if (question.about !== "speaker" || typeof words !== "number" || !Number.isFinite(words) || words <= 0) {
        return question.priority ?? 0;
    }

    return (1 - (question.confidence ?? 0.5)) * words * Math.max(1, new Set(question.decides).size);
}

/**
 * The rank a question had when it was asked (`evidence.rank`, written by `selectQuestions` and `splitQuestion`), for
 * the review rows: an answer that raises another question's confidence or detaches its targets changes its live
 * `questionRank`, and the rows must not move (R16). A question saved without one uses its live rank.
 */
export function askedRank(question: NewQuestion): number {
    const rank = question.evidence?.rank;
    return typeof rank === "number" && Number.isFinite(rank) ? rank : questionRank(question);
}

/**
 * The open questions, the most valuable first, then in transcript order. The group `words` comes after every other
 * group, the most heard word first.
 */
export function openQuestions(record: MeetingRecord): QuestionItem[] {
    const words = (item: QuestionItem) => (item.group === "words" ? 1 : 0);
    return record.items
        .filter((item): item is QuestionItem => item.kind === "question" && item.status === "suggested")
        .sort(
            (a, b) =>
                words(a) - words(b) ||
                (words(a) === 1 ? heardTimes(b) - heardTimes(a) : questionRank(b) - questionRank(a)) ||
                a.fromSec - b.fromSec
        );
}

/** The `occurrence`-th whole-word occurrence of a word question's heard words in its range. */
function heardLine(question: QuestionItem, lines: TranscriptLines, occurrence: number): HeardOccurrence | undefined {
    if (!question.heard) {
        return undefined;
    }

    const transcriptLine = question.evidence?.transcriptLine;
    const matches = lines.occurrences({ heard: question.heard, fromSec: question.fromSec, toSec: question.toSec });
    return typeof transcriptLine === "number"
        ? matches.filter((one) => one.index === transcriptLine)[occurrence]
        : matches[occurrence];
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
            item.evidence?.transcriptLine === question.evidence?.transcriptLine &&
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
        .startingBetween(question.fromSec - 0.5, Math.max(question.toSec, question.fromSec))
        .filter(({ entry }) => entry.startSec! <= question.toSec || entry.startSec === question.fromSec)
        .map(({ entry }) => entry.text)
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
    const voiceSources =
        question.about === "speaker"
            ? [
                  ...linesOf(transcript)
                      .startingBetween(question.fromSec, question.toSec)
                      .flatMap(({ entry }) =>
                          entry.nameSource === "voice" && entry.startSec! < question.toSec ? [entry] : []
                      ),
                  ...itemsNamed(record, question.decides).flatMap((item) =>
                      item.kind === "speaker-range" &&
                      item.status === "suggested" &&
                      item.speaker &&
                      question.decides.includes(item.id) &&
                      !needsSpeakerReview(item) &&
                      item.rules.includes(MeetingRule.VoiceEmbedding)
                          ? [
                                {
                                    nameSource: "voice" as const,
                                    nameScore:
                                        typeof item.evidence?.score === "number"
                                            ? item.evidence.score
                                            : item.confidence,
                                },
                            ]
                          : []
                  ),
              ]
            : [];
    const voice = [...new Set(voiceSources.map(voiceNameText))].join(", ");
    return {
        label: questionLabel(record, question.id),
        question: `${question.question}${voice ? ` (${voice})` : ""}`,
        range: `${formatClock(question.fromSec)}–${formatClock(question.toSec)}`,
        ...(question.priority === undefined ? {} : { priority: question.priority }),
        ...(context ? { context } : {}),
        ...(said ? { said } : {}),
    };
}

export function heardKey(question: QuestionItem): string | undefined {
    const heard = question.heard?.trim().toLocaleLowerCase();
    return heard || undefined;
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
