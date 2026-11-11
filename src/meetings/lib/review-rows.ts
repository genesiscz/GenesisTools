import { isDeepStrictEqual } from "node:util";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { LINE_AT_TOLERANCE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { z } from "zod";
import { actorText } from "./decision-journal";
import { itemWhat } from "./item-text";
import { momentsInText } from "./moment-schema";
import { inputNeeded, NONE_OF_THESE, type QuestionItem, questionLabel, questionView } from "./questions";
import type {
    ClockTime,
    ReviewRow,
    ReviewRows,
    ReviewRowsPatch,
    RowChoice,
    RowPart,
    RowSource,
    TextPiece,
} from "./review-row-schema";
import { speakerChoiceScores } from "./speaker-scores";

export * from "./review-row-schema";

/**
 * The review rows of a meeting (F3): one row per item with its structured question, its typed choices, its edit kind,
 * its sources, its Moment and its last decision. The Meetings window, `tools meetings rows`, `items` and the REPL print
 * from these rows, so a question reads the same everywhere and the window computes nothing itself.
 *
 * The order is one rule (G32): questions first, the most valuable first (priority, highest first) and then by time,
 * which is the order `listen` asks them in; then every other item by time, then by id. A decision changes neither
 * priority nor time, so a decided row stays where it was (R16). Open questions under `playback.listen.minPriority` are
 * left out, as `listen` leaves them, and counted (G13).
 */

type Transcript = readonly TranscriptEntry[] | TranscriptLines;
type TermItem = Extract<MeetingItem, { kind: "term" }>;

export function clockTime(sec: number): ClockTime {
    return { sec, text: formatClock(sec) };
}

/** Characters of transcript a row quotes before it cuts with "…". */
const SAID_CHARS = 240;

/** One typed candidate score as suggest writes it (`evidence.candidateScores`); other keys are dropped. */
const candidateScoreSchema = z.object({ term: z.string(), confidence: z.number() });

/**
 * A term's candidates with their confidence 0 to 1, best first: the typed `evidence.candidateScores` of a newer
 * suggestion, else the "EMP 82 %" strings of `evidence.candidates` a saved record holds (decision 7). A candidate
 * without a score is left out rather than given one.
 */
export function candidateScores(item: MeetingItem): Array<{ term: string; confidence: number }> {
    const typed = item.evidence?.candidateScores;

    if (Array.isArray(typed)) {
        return typed
            .flatMap((one: unknown) => {
                const candidate = candidateScoreSchema.safeParse(one);
                return candidate.success ? [candidate.data] : [];
            })
            .sort((a, b) => b.confidence - a.confidence);
    }

    const strings = item.evidence?.candidates;

    if (!Array.isArray(strings)) {
        return [];
    }

    return strings
        .flatMap((one: unknown) => {
            const match = typeof one === "string" ? /^(.*\S)\s+(\d+(?:[.,]\d+)?)\s*%$/u.exec(one) : null;
            return match ? [{ term: match[1]!, confidence: Number(match[2]!.replace(",", ".")) / 100 }] : [];
        })
        .sort((a, b) => b.confidence - a.confidence);
}

const REFERENCE_PATTERNS: Array<{ pattern: RegExp; piece: (match: RegExpExecArray) => Omit<TextPiece, "text"> }> = [
    { pattern: /https?:\/\/[^\s)>\]]+/gu, piece: (match) => ({ url: match[0] }) },
    { pattern: /\bcommit\s+([0-9a-f]{7,40})\b/giu, piece: (match) => ({ commit: match[1]! }) },
    { pattern: /\b(?:ADO|AB#|work item)\s*#?(\d{3,})\b/giu, piece: (match) => ({ workItem: match[1]! }) },
    {
        pattern: /([\p{L}\p{N}_./-]+)(?:\s+[0-9a-f]{7,40})?,\s*(?:line|ř\.)\s*(\d+)/giu,
        piece: (match) => ({ document: { path: match[1]!, line: Number(match[2]) } }),
    },
];

/**
 * A reason or a question text as pieces: plain words, the times and ranges it names (a Moment each), and the commits,
 * work items, document lines and URLs it cites (G19). One parser for every row text.
 */
export function textPieces(text: string): TextPiece[] {
    const found: Array<{ start: number; end: number; piece: TextPiece }> = momentsInText(text).map((mention) => ({
        start: mention.start,
        end: mention.end,
        piece: { text: mention.text, target: mention.target },
    }));

    for (const { pattern, piece } of REFERENCE_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
            const start = match.index;
            const end = start + match[0].length;

            if (!found.some((one) => one.start < end && start < one.end)) {
                found.push({ start, end, piece: { text: match[0], ...piece(match as RegExpExecArray) } });
            }
        }
    }

    found.sort((a, b) => a.start - b.start);
    const pieces: TextPiece[] = [];
    let at = 0;

    for (const one of found) {
        if (one.start > at) {
            pieces.push({ text: text.slice(at, one.start) });
        }

        pieces.push(one.piece);
        at = one.end;
    }

    if (at < text.length) {
        pieces.push({ text: text.slice(at) });
    }

    return pieces;
}

/**
 * What the engine's own question sentences ask, without the times baked into them (G20): the row's `when` part holds
 * the time as a Moment. An agent's question text matches none and is kept whole, its times turned into Moments.
 */
const ENGINE_QUESTIONS: Array<{ pattern: RegExp; asks: (match: RegExpExecArray) => string }> = [
    {
        pattern: /^Who speaks under (.+?) from \S+ to \S+?(?: \(\d+ ranges\))?\?$/u,
        asks: (match) => `Who speaks under ${match[1]}?`,
    },
    { pattern: /^Is "(.+)" at \S+ really "(.+)"\?$/u, asks: (match) => `Is "${match[1]}" really "${match[2]}"?` },
    { pattern: /^What is "(.+)" at \S+\?$/u, asks: (match) => `What is "${match[1]}"?` },
    { pattern: /^Who says "(.+)" \(\S+ to \S+?(?:, [^)]*)?\)\?$/u, asks: (match) => `Who says "${match[1]}"?` },
];

function askedPieces(question: QuestionItem): TextPiece[] {
    for (const { pattern, asks } of ENGINE_QUESTIONS) {
        const match = pattern.exec(question.question);

        if (match) {
            return [{ text: asks(match) }];
        }
    }

    return textPieces(question.question);
}

function linesOf(transcript: Transcript): TranscriptLines {
    return transcript instanceof TranscriptLines ? transcript : new TranscriptLines(transcript);
}

/** The transcript line at a time: one starting there, else the last one that started before it. */
function lineAt(lines: TranscriptLines, atSec: number): { index: number; entry: TranscriptEntry } | undefined {
    let found: { index: number; entry: TranscriptEntry } | undefined;

    for (const [index, entry] of lines.entries.entries()) {
        if (entry.startSec === undefined) {
            continue;
        }

        if (entry.startSec > atSec + LINE_AT_TOLERANCE_SEC) {
            break;
        }

        found = { index, entry };
    }

    return found;
}

function cut(text: string): string {
    return text.length > SAID_CHARS ? `${text.slice(0, SAID_CHARS)}…` : text;
}

/**
 * The words said from one time to another, each line that starts in the span. With `voices`, only the lines of those
 * voices (a speaker range quotes its own speaker, not the people talking over it); all lines when none of theirs is
 * in the span.
 */
function saidBetween(lines: TranscriptLines, fromSec: number, toSec: number, voices: readonly string[] = []): string {
    const inSpan = lines.entries.filter(
        (entry) => entry.startSec !== undefined && entry.startSec >= fromSec - 0.5 && entry.startSec < toSec
    );
    const own = inSpan.filter((entry) => voices.some((voice) => sameName(voice, entry.speaker)));
    return (own.length > 0 ? own : inSpan).map((entry) => entry.text).join(" ");
}

/**
 * The names a speaker range's lines carry: its label, or the label's name in this meeting. Not the range's proposed
 * speaker: that may be someone else talking in the same span.
 */
function voicesOf(record: MeetingRecord, item: MeetingItem): string[] {
    if (item.kind !== "speaker-range") {
        return [];
    }

    return [item.label, record.speakers.labels[item.label]].filter(
        (name): name is string => typeof name === "string" && name.length > 0
    );
}

/** The answer an earlier question about the same words got, as `listen` offers it ("as at 1:49:54"). */
function earlierAnswer(record: MeetingRecord, question: QuestionItem): { answer: string; atSec: number } | undefined {
    const heard = question.heard?.toLowerCase();

    if (!heard) {
        return undefined;
    }

    const earlier = record.items.findLast(
        (item): item is QuestionItem =>
            item.kind === "question" &&
            item.id !== question.id &&
            item.status === "confirmed" &&
            item.answer !== undefined &&
            item.heard?.toLowerCase() === heard
    );
    return earlier?.answer === undefined ? undefined : { answer: earlier.answer, atSec: earlier.fromSec };
}

/** R49: every scored choice is highest first, regardless of its role; unscored actions keep their engine order. */
function ordered(choices: RowChoice[]): RowChoice[] {
    const scored = choices
        .filter((choice) => choice.confidence !== undefined)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const unscored = choices.filter((choice) => choice.confidence === undefined);
    return [...scored, ...unscored];
}

function confidenceOf(value: number | undefined): { confidence?: number } {
    return value === undefined ? {} : { confidence: value };
}

/** The proposed answer of a term: its spelling, else the document line it reads aloud, else what it means. */
function termValue(item: TermItem): string | undefined {
    return item.proposed ?? item.quote?.text ?? item.meaning;
}

/** The best candidate of a term that is neither its suggestion nor its heard words (GLOSSARY.md "presumed"). */
function presumedOf(term: TermItem, suggested: string | undefined) {
    const taken = new Set([suggested?.toLowerCase(), term.heard.toLowerCase()]);
    return candidateScores(term).find((candidate) => !taken.has(candidate.term.toLowerCase()));
}

function termChoices(item: TermItem): RowChoice[] {
    const suggested = termValue(item);
    const presumed = presumedOf(item, suggested);
    return ordered([
        ...(suggested
            ? [
                  {
                      value: suggested,
                      label: suggested,
                      role: "suggested" as const,
                      action: { kind: "confirm" as const },
                      ...confidenceOf(item.confidence),
                  },
              ]
            : []),
        ...(presumed
            ? [
                  {
                      value: presumed.term,
                      label: presumed.term,
                      role: "presumed" as const,
                      action: { kind: "respell" as const, text: presumed.term },
                      confidence: presumed.confidence,
                  },
              ]
            : []),
        {
            value: item.heard,
            label: "Keep as heard",
            role: "heard" as const,
            action: { kind: "reject" as const },
        },
    ]);
}

/** A choice's score among a speaker range's typed candidate scores (G31), by the identity rules. */
function scoreOf(scores: Map<string, number>, name: string): number | undefined {
    return [...scores].find(([speaker]) => sameName(speaker, name))?.[1];
}

function rangeChoices(item: Extract<MeetingItem, { kind: "speaker-range" }>): RowChoice[] {
    const others = (item.candidates ?? []).filter((name) => name !== item.speaker);
    const scores = speakerChoiceScores([item]);
    return ordered([
        ...(item.speaker
            ? [
                  {
                      value: item.speaker,
                      label: item.speaker,
                      role: "suggested" as const,
                      action: { kind: "confirm" as const },
                      ...confidenceOf(item.confidence),
                  },
              ]
            : []),
        ...ordered(
            others.map((name) => ({
                value: name,
                label: name,
                role: "candidate" as const,
                action: { kind: "confirm" as const, speaker: name },
                ...confidenceOf(scoreOf(scores, name)),
            }))
        ),
        { value: NONE_OF_THESE, label: "None of these", role: "none" as const, action: { kind: "reject" as const } },
    ]);
}

function plainChoices(item: MeetingItem, label: string): RowChoice[] {
    return [
        {
            value: label,
            label,
            role: "suggested",
            action: { kind: "confirm" },
            ...confidenceOf(item.confidence),
        },
        { value: NONE_OF_THESE, label: "Reject", role: "none", action: { kind: "reject" } },
    ];
}

/**
 * A question's choices (G1, G2, G31, G32): the engine's answers with their roles and confidence (a term's suggestion
 * the term's own, its candidates their scores; a speaker question's suggested speaker the range's confidence and the
 * other names their typed candidate scores over the ranges it decides, none for a name without one), then "None of
 * these", "Several voices" for a speaker question, and "Skip".
 */
function questionChoices(record: MeetingRecord, question: QuestionItem): RowChoice[] {
    const decided = record.items.filter((item) => question.decides.includes(item.id));
    const term = decided.find((item): item is TermItem => item.kind === "term");
    const range = decided.find(
        (item): item is Extract<MeetingItem, { kind: "speaker-range" }> => item.kind === "speaker-range"
    );
    const suggested = question.about === "speaker" ? range?.speaker : term ? termValue(term) : undefined;
    const scores = term ? candidateScores(term) : [];
    const speakerScores =
        question.about === "speaker"
            ? speakerChoiceScores(
                  decided.filter(
                      (item): item is Extract<MeetingItem, { kind: "speaker-range" }> => item.kind === "speaker-range"
                  )
              )
            : new Map<string, number>();
    const presumed = term ? presumedOf(term, suggested) : undefined;
    const earlier = earlierAnswer(record, question);
    const answer = (value: string) => ({ kind: "answer" as const, answer: value });
    const values = [...question.choices];

    if (presumed && !values.some((value) => value.toLowerCase() === presumed.term.toLowerCase())) {
        values.push(presumed.term);
    }

    const answers = values.map((value): RowChoice => {
        const lower = value.toLowerCase();
        const role =
            earlier && value === earlier.answer
                ? "earlier"
                : suggested && lower === suggested.toLowerCase()
                  ? "suggested"
                  : presumed && lower === presumed.term.toLowerCase()
                    ? "presumed"
                    : question.heard && lower === question.heard.toLowerCase()
                      ? "heard"
                      : "candidate";
        const confidence =
            role === "suggested"
                ? (question.about === "speaker" ? range : term)?.confidence
                : question.about === "speaker"
                  ? scoreOf(speakerScores, value)
                  : scores.find((score) => score.term.toLowerCase() === lower)?.confidence;
        return {
            value,
            label: value,
            role,
            action: answer(value),
            ...confidenceOf(confidence),
            ...(role === "earlier" && earlier ? { hint: `as at ${formatClock(earlier.atSec)}` } : {}),
        };
    });

    if (earlier && !values.includes(earlier.answer)) {
        answers.unshift({
            value: earlier.answer,
            label: earlier.answer,
            role: "earlier",
            action: answer(earlier.answer),
            hint: `as at ${formatClock(earlier.atSec)}`,
        });
    }

    return [
        ...ordered(answers),
        {
            value: NONE_OF_THESE,
            // A word question without a candidate has no "these": the same answer reads as what it does to the word.
            label: answers.length === 0 && question.about !== "speaker" ? "Keep as heard" : "None of these",
            role: "none",
            action: answer(NONE_OF_THESE),
        },
        ...(question.about === "speaker"
            ? [{ value: "split", label: "Several voices", role: "split" as const, action: { kind: "split" as const } }]
            : []),
        { value: "skip", label: "Skip", role: "skip", action: { kind: "skip" } },
    ];
}

/**
 * The confidence of each answer of a speaker question as its row shows it (R49, G31): `listen` prints it beside the
 * name. Empty for other questions and for answers without a score.
 */
export function speakerAnswerScores(record: MeetingRecord, question: QuestionItem): Map<string, number> {
    if (question.about !== "speaker") {
        return new Map();
    }

    return new Map(
        questionChoices(record, question).flatMap(
            (choice): Array<[string, number]> =>
                choice.action.kind === "answer" && choice.confidence !== undefined
                    ? [[choice.value, choice.confidence]]
                    : []
        )
    );
}

/** When an item is: a span or a time on the transcript clock, with its Moment. */
function whenPart(item: MeetingItem): Extract<RowPart, { kind: "when" }> {
    const target = { kind: "item" as const, id: item.id };

    if (item.kind === "term" || item.kind === "join") {
        return item.atSec === undefined
            ? { kind: "when", from: clockTime(0), target }
            : { kind: "when", from: clockTime(item.atSec), target };
    }

    return {
        kind: "when",
        from: clockTime(item.fromSec),
        ...(Math.round(item.toSec) === Math.round(item.fromSec) ? {} : { to: clockTime(item.toSec) }),
        target,
    };
}

function itemTime(item: MeetingItem): number | undefined {
    return item.kind === "term" || item.kind === "join" ? item.atSec : item.fromSec;
}

function partsOf(record: MeetingRecord, item: MeetingItem, lines: TranscriptLines | undefined): RowPart[] {
    const parts: RowPart[] = [];
    const at = itemTime(item);
    const line = lines && at !== undefined ? lineAt(lines, at) : undefined;

    if (item.kind === "question") {
        const view = lines ? questionView(record, item, lines, SAID_CHARS) : undefined;
        const ranges = record.items.filter(
            (one): one is Extract<MeetingItem, { kind: "speaker-range" }> =>
                one.kind === "speaker-range" && item.decides.includes(one.id)
        );
        const who = [...new Set(ranges.map((range) => range.label))].join(", ") || line?.entry.speaker;

        if (who) {
            parts.push({ kind: "who", text: who });
        }

        if (view?.context) {
            const context = view.context;
            parts.push({
                kind: "said",
                text: `${context.lead}${context.heard}${context.rest}`,
                ...(line ? { speaker: line.entry.speaker } : {}),
                context,
            });
        } else if (view?.said) {
            parts.push({ kind: "said", text: view.said });
        } else if (item.heard) {
            parts.push({ kind: "said", text: item.heard });
        }

        parts.push(whenPart(item));
        parts.push({ kind: "asks", pieces: askedPieces(item) });

        if (item.decides.length > 0) {
            const n = item.decides.length;
            parts.push({ kind: "settles", text: `It settles ${n} item${n === 1 ? "" : "s"}`, items: item.decides });
        }
    } else {
        if (item.kind === "speaker-range" || item.kind === "label") {
            parts.push({
                kind: "who",
                text: item.kind === "speaker-range" && item.speaker ? `${item.label} → ${item.speaker}` : item.label,
            });
        } else if (line) {
            parts.push({ kind: "who", text: line.entry.speaker });
        }

        const said =
            item.kind === "join"
                ? item.joined
                : item.kind === "term"
                  ? line?.entry.text
                  : lines
                    ? saidBetween(lines, item.fromSec, item.toSec, voicesOf(record, item))
                    : undefined;

        if (said) {
            parts.push({ kind: "said", text: cut(said) });
        }

        parts.push(whenPart(item));
    }

    const reason = item.evidence?.reason;

    if (typeof reason === "string" && reason.trim()) {
        parts.push({ kind: "reason", pieces: textPieces(reason.trim()) });
    }

    return parts;
}

function sourcesOf(item: MeetingItem, parts: RowPart[], lines: TranscriptLines | undefined): RowSource[] {
    const sources: RowSource[] = [];
    const evidence = item.evidence ?? {};
    const index = typeof evidence.transcriptLine === "number" ? evidence.transcriptLine : undefined;
    const at = itemTime(item);

    if (at !== undefined && (index !== undefined || lines)) {
        const entry = index !== undefined ? lines?.entries[index] : lines ? lineAt(lines, at)?.entry : undefined;
        sources.push({
            kind: "line",
            at: clockTime(entry?.startSec ?? at),
            ...(index !== undefined ? { line: index } : {}),
            ...(entry ? { text: cut(entry.text) } : {}),
        });
    }

    if (typeof evidence.doc === "string") {
        sources.push({
            kind: "document",
            path: evidence.doc,
            ...(typeof evidence.line === "number" ? { line: evidence.line } : {}),
        });
    }

    const reason = parts.find((part) => part.kind === "reason");

    for (const piece of reason?.kind === "reason" ? reason.pieces : []) {
        if (piece.commit) {
            sources.push({ kind: "commit", sha: piece.commit });
        } else if (piece.workItem) {
            sources.push({ kind: "workItem", id: piece.workItem });
        } else if (piece.document) {
            sources.push({ kind: "document", ...piece.document });
        } else if (piece.url) {
            sources.push({ kind: "url", url: piece.url });
        }
    }

    return sources;
}

const EDITS: Record<MeetingItem["kind"], ReviewRow["edit"]> = {
    term: "spelling",
    "speaker-range": "person",
    question: "answer",
    join: "none",
    label: "none",
};

function choicesOf(record: MeetingRecord, item: MeetingItem): RowChoice[] {
    switch (item.kind) {
        case "question":
            return questionChoices(record, item);
        case "term":
            return termChoices(item);
        case "speaker-range":
            return rangeChoices(item);
        case "join":
            return plainChoices(item, item.joined ? `Join "${item.joined}"` : "Join");
        case "label":
            return plainChoices(item, `${item.label} tracks no one person`);
    }
}

/** What a decided item was decided as; nothing for an open or rejected one, and for a kind that decides no value. */
function decidedAs(item: MeetingItem): string | undefined {
    if (item.kind === "question") {
        return item.answer;
    }

    if (item.status !== "confirmed") {
        return undefined;
    }

    if (item.kind === "term") {
        return item.proposed;
    }

    return item.kind === "speaker-range" ? item.speaker : undefined;
}

/** One item's row. `transcript`: the meeting's lines, for what was said; without it a row names no words. */
export function reviewRow(record: MeetingRecord, item: MeetingItem, transcript?: Transcript): ReviewRow {
    const lines = transcript ? linesOf(transcript) : undefined;
    const parts = partsOf(record, item, lines);
    const needs = inputNeeded(item) ?? (item.kind === "question" && item.status === "suggested" ? "listen" : undefined);
    const decision = item.decision;
    const actor = decision?.actor ?? { kind: "unknown" as const };
    const answer = decidedAs(item);
    return {
        id: item.id,
        label: item.kind === "question" ? questionLabel(record, item.id) : item.id,
        kind: item.kind,
        status: item.status,
        ...confidenceOf(item.confidence),
        ...(item.kind === "question" && item.priority !== undefined ? { priority: item.priority } : {}),
        what: itemWhat(item),
        parts,
        choices: choicesOf(record, item),
        edit: EDITS[item.kind],
        ...(needs ? { needs } : {}),
        sources: sourcesOf(item, parts, lines),
        target: { kind: "item", id: item.id },
        ...(decision
            ? {
                  decision: {
                      token: decision.token,
                      actor,
                      by: actorText(actor),
                      action: decision.entry?.action ?? "unknown",
                      ...(decision.entry?.reason ? { reason: decision.entry.reason } : {}),
                      ...(decision.entry?.question ? { question: decision.entry.question } : {}),
                      ...(item.decidedAt ? { at: item.decidedAt } : {}),
                  },
              }
            : {}),
        ...(answer ? { answer } : {}),
    };
}

/** The row order (see the module comment): questions by priority then time, then the rest by time, then id. */
function rowOrder(a: MeetingItem, b: MeetingItem): number {
    const aQuestion = a.kind === "question";
    const bQuestion = b.kind === "question";

    if (aQuestion !== bQuestion) {
        return aQuestion ? -1 : 1;
    }

    if (a.kind === "question" && b.kind === "question") {
        const byPriority = (b.priority ?? 0) - (a.priority ?? 0);

        if (byPriority !== 0) {
            return byPriority;
        }
    }

    return (itemTime(a) ?? 0) - (itemTime(b) ?? 0) || a.id.localeCompare(b.id, undefined, { numeric: true });
}

/**
 * Every row of a meeting in the row order, with the count of the open questions left out under `minPriority`
 * (`lowPriority: "show"` keeps them).
 */
export function reviewRows(
    record: MeetingRecord,
    options: { transcript?: Transcript; minPriority: number; lowPriority?: "hide" | "show" }
): ReviewRows {
    const lines = options.transcript ? linesOf(options.transcript) : undefined;
    const low = (item: MeetingItem) =>
        item.kind === "question" &&
        item.status === "suggested" &&
        (item.priority ?? options.minPriority) < options.minPriority;
    const shown = record.items.filter((item) => options.lowPriority === "show" || !low(item));
    return {
        meeting: record.id,
        rows: [...shown].sort(rowOrder).map((item) => reviewRow(record, item, lines)),
        hidden: {
            lowPriority: options.lowPriority === "show" ? 0 : record.items.filter(low).length,
            minPriority: options.minPriority,
        },
    };
}

/** Compare every rendered row: a decision can change another row's choices without changing that item's status. */
export function reviewRowsPatch(options: {
    before: MeetingRecord;
    after: MeetingRecord;
    transcript?: Transcript;
    minPriority: number;
    lowPriority?: "hide" | "show";
}): ReviewRowsPatch {
    const before = reviewRows(options.before, options);
    const after = reviewRows(options.after, options);
    const previous = new Map(before.rows.map((row) => [row.id, row]));
    const next = new Map(after.rows.map((row) => [row.id, row]));
    const fields = (record: MeetingRecord) => ({
        title: record.title,
        ...(record.project ? { project: record.project } : {}),
        labels: record.labels,
        speakerLabels: record.speakers.labels,
    });
    return {
        meeting: after.meeting,
        changes: [...new Set([...previous.keys(), ...next.keys()])].flatMap((id) => {
            const was = previous.get(id),
                now = next.get(id);
            return isDeepStrictEqual(was, now)
                ? []
                : [{ id, ...(was ? { before: was } : {}), ...(now ? { after: now } : {}) }];
        }),
        order: after.rows.map((row) => row.id),
        hidden: { before: before.hidden, after: after.hidden },
        fields: { before: fields(options.before), after: fields(options.after) },
    };
}
