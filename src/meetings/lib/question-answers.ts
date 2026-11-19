import type { Correction } from "@genesiscz/utils/meetings/corrections";
import { voiceRuns } from "@genesiscz/utils/meetings/energy";
import { nameKey } from "@genesiscz/utils/meetings/people";
import { type MeetingItem, type MeetingRecord, meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { type DictionaryEntry, dictionaryEntrySchema } from "@genesiscz/utils/transcribe/dictionary";
import { importanceOf } from "@genesiscz/utils/transcribe/importance";
import { LAST_LINE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { sameName } from "@genesiscz/utils/transcribe/speakers";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { parsePersonAnswer, personPresent, recordPeople, sentenceSegments } from "./listen-answers";
import {
    heardKey,
    heardTimes,
    linesOf,
    type NewQuestion,
    NONE_OF_THESE,
    openQuestions,
    type QuestionItem,
    questionRank,
    type RangeItem,
    TERM_CLIP_SEC,
    wordPriority,
} from "./questions";
import { anchorScores, needsSpeakerReview, speakerScoresOf } from "./speaker-scores";
import { decisionLedger, ledgerEntryFor } from "./transcript-corrections";

/** An answer raises compatible questions for the same labelled passage by this much, up to `PROPAGATED_MAX`. */
const PROPAGATED_BONUS = 0.3;
const PROPAGATED_MAX = 0.9;

/**
 * One answer settles compatible open speaker questions for the same single label and evidence group. They must share
 * its signature and offer the answer, which raises their items by +0.3 up to 0.9. A question that reaches
 * `listenBelow` is closed as settled; the others stay, scored higher. Returns the questions it closed. Mutates `record`.
 */
export function propagateAnswer(
    record: MeetingRecord,
    answered: QuestionItem,
    options: { answer: string; listenBelow: number; now: string; except?: readonly string[] }
): string[] {
    if (
        answered.about !== "speaker" ||
        !answered.signature ||
        answered.evidence?.reviewOnly === true ||
        options.answer.toLowerCase() === NONE_OF_THESE
    ) {
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
            options.except?.includes(question.id) ||
            question.signature !== answered.signature ||
            question.evidence?.reviewOnly === true ||
            !offers ||
            !Array.isArray(otherLabels) ||
            otherLabels.length !== 1 ||
            otherLabels[0] !== labels[0]
        ) {
            continue;
        }

        detachTargets({ question, except: options.except });
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
            const scores = speakerScoresOf(item);

            // The answer raised its speaker: the other candidates keep their proportions in the room it leaves.
            if (scores.length > 0) {
                item.evidence = {
                    ...item.evidence,
                    candidateScores: anchorScores(scores, options.answer, item.confidence, [
                        { kind: "answer", rule: MeetingRule.User },
                    ]),
                };
            }
        }

        question.confidence = lowest;

        if (lowest >= options.listenBelow) {
            for (const item of record.items) {
                if (item.kind === "speaker-range" && question.decides.includes(item.id)) {
                    item.status = "confirmed";
                    item.decidedAt = options.now;
                }
            }

            question.status = "rejected";
            question.decidedAt = options.now;
            question.comment = `settled by the answer to ${answered.id}`;
            settled.push(question.id);
        }
    }

    const askedTargets = new Set(record.items.flatMap((item) => (item.kind === "question" ? item.decides : [])));
    for (const item of record.items) {
        if (
            item.kind !== "speaker-range" ||
            item.status !== "suggested" ||
            askedTargets.has(item.id) ||
            options.except?.includes(item.id) ||
            item.label !== labels[0] ||
            item.evidence?.signature !== answered.signature ||
            needsSpeakerReview(item) ||
            !Array.isArray(item.evidence?.choices) ||
            !item.evidence.choices.some((name) => typeof name === "string" && sameName(name, options.answer))
        ) {
            continue;
        }
        item.speaker = options.answer;
        item.confidence = Math.min(PROPAGATED_MAX, Math.round(((item.confidence ?? 0) + PROPAGATED_BONUS) * 100) / 100);
        item.rules = [...new Set([...item.rules, MeetingRule.User])];
        const scores = speakerScoresOf(item);
        item.evidence = {
            ...item.evidence,
            propagatedFrom: answered.id,
            ...(scores.length
                ? {
                      candidateScores: anchorScores(scores, options.answer, item.confidence, [
                          { kind: "answer", rule: MeetingRule.User },
                      ]),
                  }
                : {}),
        };
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

        // A part counts its own words, not the whole question's, and ranks by them from the moment it is asked. A
        // legacy question without a word count keeps its priority for its parts.
        const part = {
            ...question,
            decides: decided ? [decided.id] : [],
            evidence:
                typeof question.evidence?.words === "number"
                    ? { ...question.evidence, words: importanceOf(words).words }
                    : question.evidence,
        };
        const asked = meetingItemSchema.parse({
            ...part,
            id: nextId("i", record.items),
            status: "suggested",
            fromSec: run.fromSec,
            toSec: run.toSec,
            question: `Who says "${words.length > 120 ? `${words.slice(0, 120)}…` : words}" (${formatClock(run.fromSec)} to ${formatClock(run.toSec)}${SIDE_HINT[run.side]})?`,
            evidence: { ...part.evidence, rank: questionRank(part) },
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

function detachTargets(options: { question: QuestionItem; except?: readonly string[] }): void {
    if (options.except?.length) {
        const excluded = new Set(options.except);
        options.question.decides = options.question.decides.filter((id) => !excluded.has(id));
    }
}

/**
 * Writes an answer into the record: the question is confirmed, and each item it decides is confirmed with the answer
 * (a range's speaker, a term's spelling, a join's speaker) or rejected when the answer is "none of these". Returns
 * the confirmed term and join corrections for the ledger. Mutates `record`.
 */
export function answerQuestion(
    record: MeetingRecord,
    id: string,
    options: {
        answer: string;
        /** A journaled single-speaker name can be absent from this copy's current choice list. */
        knownSpeaker?: boolean;
        comment?: string;
        now: string;
        except?: readonly string[];
        transcript?: readonly TranscriptEntry[];
        people?: readonly string[];
        segments?: Array<{ fromWord: number; speaker: string }>;
    }
): Correction[] {
    const question = record.items.find((item): item is QuestionItem => item.id === id && item.kind === "question");

    if (!question) {
        throw new Error(`${record.id} has no question ${id}`);
    }

    let answer = options.answer.trim();
    if (!answer && options.comment?.trim()) {
        question.comment = [question.comment, options.comment.trim()].filter(Boolean).join("\n");
        return [];
    }
    if (!answer) {
        throw new Error("An empty answer decides nothing: answer with a person, word or comment");
    }
    const parsed =
        question.about === "speaker" && !options.knownSpeaker && answer.toLowerCase() !== NONE_OF_THESE
            ? parsePersonAnswer({
                  text: answer,
                  people: [...question.choices, ...recordPeople(record), ...(options.people ?? [])].filter(
                      (name) =>
                          question.choices.some((choice) => sameName(choice, name)) ||
                          personPresent(record, name, question.fromSec)
                  ),
                  self: record.participants.find((person) => person.self)?.name,
              })
            : undefined;
    if (parsed?.kind === "comment") {
        question.comment = [question.comment, parsed.text, options.comment].filter(Boolean).join("\n");
        return [];
    }
    const voices = parsed?.kind === "people" ? parsed.people : undefined;
    if (
        options.segments &&
        (!voices ||
            options.segments[0]?.fromWord !== 0 ||
            options.segments.some(
                (segment, index) =>
                    !voices.includes(segment.speaker) ||
                    (index > 0 && segment.fromWord <= options.segments![index - 1]!.fromWord)
            ))
    ) {
        throw new Error("Voice segments need known speakers, start at word zero and increase strictly");
    }
    if (voices) {
        answer = voices.join(" + ");
    }

    if (!answer) {
        throw new Error(`An empty answer decides nothing: answer ${id} with a name or a word, or "${NONE_OF_THESE}"`);
    }

    const none = answer.toLowerCase() === NONE_OF_THESE;
    if (
        question.about === "speaker" &&
        (question.group === "spot-check" || question.group === "long-stretch") &&
        !none &&
        question.decides.length === 0 &&
        options.transcript
    ) {
        const lines = new TranscriptLines(options.transcript);
        const at = options.transcript.findLastIndex(
            (entry) => entry.startSec !== undefined && entry.startSec <= question.fromSec
        );
        const source = options.transcript[at];
        if (source?.startSec !== undefined && (lines.end(at) ?? source.startSec) >= question.fromSec) {
            const target = meetingItemSchema.parse({
                id: nextId("i", record.items),
                kind: "speaker-range",
                label: source.speaker,
                fromSec: source.startSec,
                toSec: source.startSec,
                status: "suggested",
                rules: question.rules,
                suggestedAt: options.now,
                evidence: { transcriptLine: at, endSec: lines.end(at), splitQuestion: question.id },
            });
            record.items.push(target);
            question.decides.push(target.id);
        }
    }
    question.status = "confirmed";
    question.answer = answer;
    question.decidedAt = options.now;

    if (options.comment?.trim()) {
        question.comment = options.comment.trim();
    }

    // A target struck from the answer leaves the question: it stays as it was, for its own decision.
    detachTargets({ question, except: options.except });

    const ledger: Correction[] = [];

    for (const item of record.items) {
        if (!question.decides.includes(item.id) || item.kind === "question") {
            continue;
        }

        item.decidedAt = options.now;
        const prior = ledgerEntryFor(record, item, options.now);

        if (none) {
            item.status = "rejected";
            ledger.push(...decisionLedger(prior, undefined));
            continue;
        }

        item.status = "confirmed";

        if (item.kind === "speaker-range" || item.kind === "join") {
            item.speaker = answer;

            // A new answer replaces the whole split of an earlier one: a one-person answer leaves no voices behind.
            if (item.kind === "speaker-range") {
                delete item.voices;
                delete item.segments;
            }

            if (item.kind === "speaker-range" && voices && voices.length > 1) {
                const source = options.transcript?.find(
                    (line) => line.speaker === item.label && line.startSec === item.fromSec
                );
                item.voices = voices;
                item.segments = options.segments ?? (source ? sentenceSegments(source.text, voices) : undefined);
                if (
                    source &&
                    item.segments?.some((segment) => segment.fromWord >= source.text.trim().split(/\s+/).length)
                ) {
                    throw new Error("Voice split is outside the source words");
                }
            }
        }

        if (item.kind === "term") {
            item.proposed = answer;
            delete item.quote;
            delete item.meaning;
        }

        ledger.push(...decisionLedger(prior, ledgerEntryFor(record, item, options.now)));
    }

    return ledger;
}

/**
 * After an answer to a word question, every open word question whose heard word starts with the answered one (and is
 * longer) gets the derived spelling as its first choice: "zorb" answered "sorb" offers "sorb-fe" for "zorb-fe". A
 * prefix replacement, no language rule; a person still confirms each. Mutates `record`.
 */
export function siblingChoices(record: MeetingRecord, answered: QuestionItem, answer: string): void {
    const stem = answered.heard?.toLowerCase();

    if (!stem || answer.toLowerCase() === NONE_OF_THESE || answer.toLowerCase() === stem) {
        return;
    }

    for (const item of record.items) {
        if (
            item.kind !== "question" ||
            item.id === answered.id ||
            item.status !== "suggested" ||
            item.group !== "words" ||
            item.about !== "term" ||
            !item.heard ||
            item.heard.length <= stem.length ||
            !item.heard.toLowerCase().startsWith(stem)
        ) {
            continue;
        }

        const choice = answer + item.heard.slice(stem.length);

        if (!item.choices.includes(choice)) {
            item.choices.unshift(choice);
        }

        item.evidence = { ...item.evidence, derivedFrom: answered.id };
    }
}

/** The two answers of a dictionary question. */
export const DICTIONARY_CHOICES = ["add", "do not add"] as const;

/** The dictionary entry a corrected word becomes: kept as heard when the answer equals it, else a fix. */
export function learnedEntry(heard: string, fixed: string): DictionaryEntry {
    return fixed.toLowerCase() === heard.toLowerCase()
        ? dictionaryEntrySchema.parse({ type: "keep", value: heard })
        : dictionaryEntrySchema.parse({ type: "fix", value: heard, substitution: fixed });
}

/**
 * The question a corrected word leaves for a person (the owner's answer to M5): add it to the project dictionary or
 * not. The tool never adds it on its own; `listen` asks it at once in a terminal, every other caller leaves it here.
 */
export function dictionaryQuestion(options: {
    term: Extract<MeetingItem, { kind: "term" }>;
    fixed: string;
    project: string;
}): NewQuestion {
    const { term, fixed, project } = options;
    const occurrences = heardTimes(term);
    const fromSec = term.atSec ?? 0;
    const keep = fixed.toLowerCase() === term.heard.toLowerCase();
    return {
        kind: "question",
        status: "suggested",
        about: "dictionary",
        group: "words",
        fromSec,
        toSec: fromSec + TERM_CLIP_SEC,
        question: keep
            ? `Keep "${term.heard}" as a word of the ${project} dictionary? It is heard ${occurrences} times.`
            : `Add "${term.heard}" → "${fixed}" to the ${project} dictionary? It is heard ${occurrences} times.`,
        heard: term.heard,
        choices: [...DICTIONARY_CHOICES],
        decides: [],
        rules: [],
        priority: wordPriority(occurrences),
        evidence: { fixed, occurrences, item: term.id },
    };
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

/**
 * The names and words an answer may be: the attendees, the participants, the calendar, then the people the people
 * directory knows for the meeting (`known`, ranked: its people first, then everyone else it knows), then the
 * dictionary. A name the record holds keeps its place, so the terminal's choices only gain names (R10, G3).
 */
export function answerVocabulary(record: MeetingRecord, dictionaryValues: string[], known: string[] = []): string[] {
    const values = [
        ...(record.attendance?.people.map((person) => person.name) ?? []),
        ...record.participants.map((person) => person.name),
        ...(record.calendar?.attendees ?? []),
        ...recordPeople(record),
    ];
    const keys = new Set(values.map((value) => nameKey(value)));
    const others = known.filter((name) => !keys.has(nameKey(name)));
    return [...new Set([...values, ...others, ...dictionaryValues])].filter((value) => value.trim().length > 0);
}

/**
 * One answer settles its look-alikes. A speaker answer raises the questions with its signature (`propagateAnswer`).
 * A word answer answers every other open word question on the same heard words the same way, so the same word is not
 * asked twice; each is marked "settled by the answer to iN". "None of these" settles nothing. Mutates `record`.
 */
export function settleLookAlikes(
    record: MeetingRecord,
    answered: QuestionItem,
    options: { answer: string; listenBelow: number; now: string; except?: readonly string[] }
): { settled: string[]; corrections: Correction[] } {
    if (answered.about === "speaker") {
        return { settled: propagateAnswer(record, answered, options), corrections: [] };
    }

    const heard = heardKey(answered);
    const globalTerms = (question: QuestionItem) =>
        question.decides.length > 0 &&
        question.decides.every((id) => {
            const item = record.items.find((item) => item.id === id);
            return (
                item?.kind === "term" &&
                (item.scope ?? (item.quote || item.meaning ? "line" : "everywhere")) === "everywhere"
            );
        });

    if (!heard || !globalTerms(answered) || options.answer.trim().toLowerCase() === NONE_OF_THESE) {
        return { settled: [], corrections: [] };
    }

    const settled: string[] = [];
    const corrections: Correction[] = [];

    for (const question of openQuestions(record)) {
        if (
            question.id === answered.id ||
            options.except?.includes(question.id) ||
            question.about === "speaker" ||
            heardKey(question) !== heard ||
            !globalTerms(question) ||
            question.choices.length !== answered.choices.length ||
            question.choices.some((choice, index) => choice !== answered.choices[index])
        ) {
            continue;
        }

        corrections.push(
            ...answerQuestion(record, question.id, {
                answer: options.answer,
                comment: `settled by the answer to ${answered.id}`,
                now: options.now,
                except: options.except,
            })
        );
        settled.push(question.id);
    }

    return { settled, corrections };
}
