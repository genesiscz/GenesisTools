import { basename, extname } from "node:path";
import { isJsonObject } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { DictionaryCandidate, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { DEFAULT_FUZZY, fuzzyMatches, type ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import {
    docIdentifiers,
    docLines,
    findReadAloud,
    findSpokenIdentifiers,
    restatesSpokenWords,
} from "@genesiscz/utils/transcribe/doc-match";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import {
    acronymStem,
    allowsFuzzyTerm,
    findSuspectTerms,
    findUnknownWords,
    isEnglishWord,
    keepsHeardWords,
    type RawTermEvidence,
    rawTermEvidence,
    scopedVocabulary,
    termsFromText,
    type VocabTerm,
} from "@genesiscz/utils/transcribe/terms";
import { contextEntryText } from "./context-file";
import type { NewItem } from "./new-item";
import { DEFAULT_WORD_MIN_OCCURRENCES, heardTimes } from "./questions";

const { log } = logger.scoped("meetings-suggest");

/** Prefixes a Czech verb or adjective puts before its stem ("na|mokovat", "ne|mokovaný"), folded. */
const CZECH_PREFIXES = ["pre", "roz", "pri", "na", "ne", "za", "vy"] as const;
/** How many letters of the stem name a word family. */
const FAMILY_LETTERS = 4;
/** Czech endings that make a verb, an adjective or a person of an English root ("mok|ovat", "backend|isti"), folded. */
const CZECH_DERIVATIONS = [
    "ovanejch",
    "ovanejm",
    "ovanyma",
    "ovanych",
    "ovanym",
    "ovanou",
    "ovany",
    "ovana",
    "ovane",
    "ovani",
    "ovat",
    "ujete",
    "ujeme",
    "ujem",
    "ujou",
    "uje",
    "istum",
    "istou",
    "isti",
    "ista",
    "istu",
    "acky",
    "ackem",
    "ak",
    "aci",
] as const;

function folded(word: string): string {
    return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The family of a word: the first letters of its stem after one Czech prefix. The inflected forms of one word share
 * it ("mokovaný", "mokovanejm", "namokovat", "nemokovaný": `moko`), and a mishearing seldom comes in several forms.
 */
export function wordFamily(word: string): string {
    const plain = folded(word);
    const prefix = CZECH_PREFIXES.find(
        (one) => plain.startsWith(one) && plain.length - one.length >= FAMILY_LETTERS + 1
    );
    return plain.slice(prefix?.length ?? 0, (prefix?.length ?? 0) + FAMILY_LETTERS);
}

/** The English words a Czech-made word may be built on: "mok" is "mock", "komponent" is "component". */
function englishRoots(word: string): string[] {
    const plain = folded(word);
    const prefix = CZECH_PREFIXES.find((one) => plain.startsWith(one) && plain.length - one.length >= 6);
    const stem = plain.slice(prefix?.length ?? 0);
    const ending = CZECH_DERIVATIONS.find((one) => stem.endsWith(one) && stem.length - one.length >= 3);

    if (!ending) {
        return [];
    }

    const root = stem.slice(0, stem.length - ending.length);
    return [root, `${root}e`, root.replace(/k$/, "ck"), root.replace(/^k/, "c"), root.replace(/k/g, "c")];
}

/**
 * The unknown words a person said on purpose: the forms of one word family heard in two or more forms (a mishearing
 * seldom repeats in another inflection), and a Czech form of a known English word ("mokovat", "testovat"). These are
 * slang or a new term, not a mistake, so they get no item and no question (MC3, 2026-11-06: the latest meeting had 40
 * such items at 30 %, and 8 of its 12 questions asked about them).
 */
export function spokenOnPurpose(words: string[], known: (word: string) => boolean): Set<string> {
    const families = new Map<string, Set<string>>();

    for (const word of words) {
        const forms = families.get(wordFamily(word)) ?? new Set<string>();
        forms.add(word.toLowerCase());
        families.set(wordFamily(word), forms);
    }

    return new Set(
        words
            .filter(
                (word) =>
                    (families.get(wordFamily(word))?.size ?? 0) >= 2 ||
                    englishRoots(word).some((root) => root.length >= 3 && known(root))
            )
            .map((word) => word.toLowerCase())
    );
}

/** A word (or an English root) the language knows: English, or what the word check does not call unknown. */
export function knownWord(wordCheck: WordCheck | undefined): (word: string) => boolean {
    return (word) => isEnglishWord(word) || (wordCheck !== undefined && wordCheck.verdict(word).class !== "unknown");
}

/**
 * An unknown word with a candidate from the meeting itself at 80 % or more is proposed even when its family is said
 * on purpose (MC5): the suggestion and the retirement of a later run read it the same way. The exception: a heard form
 * spelled as an acronym (capitals and digits, `acronymStem`) counts a candidate at that score or more from any source.
 */
function strongMeetingCandidate(heard: string, evidence: unknown, threshold: number): boolean {
    if (
        !isJsonObject(evidence) ||
        !Array.isArray(evidence.candidateSources) ||
        !Array.isArray(evidence.candidateScores)
    ) {
        return false;
    }

    const scores = evidence.candidateScores;
    return evidence.candidateSources.some(
        (source) =>
            isJsonObject(source) &&
            (source.source === "meeting" || acronymStem(heard)) &&
            scores.some(
                (score) =>
                    isJsonObject(score) &&
                    score.term === source.term &&
                    typeof score.confidence === "number" &&
                    score.confidence >= threshold
            )
    );
}

/** The words the dictionary settles: kept, fixed as one word, or a term's spoken form; lower case. */
export function dictionaryKeeps(dictionary: Pick<ResolvedDictionary, "entries">): Set<string> {
    return new Set(
        dictionary.entries.flatMap((entry) => {
            if (entry.type === "keep") {
                return [entry.value.toLowerCase()];
            }

            if (entry.type === "fix") {
                return entry.value.toLowerCase().split(/\s+/).length === 1 ? [entry.value.toLowerCase()] : [];
            }

            return entry.type === "term" ? (entry.spoken ?? []).map((form) => form.toLowerCase()) : [];
        })
    );
}

/** A word no dictionary layer knows and no term matches: probably misheard, but into what is open. */
const UNKNOWN_WORD_CONFIDENCE = 0.3;

export interface TermSources {
    meeting: SourceMeeting;
    record: MeetingRecord;
    /** How a quote names its source (`languages.<global.language>.render`): "(čte z WikiProposals, ř. 33)". */
    sourceLabels?: { readAloudLabel: string; lineLabel: string };
    dictionary: ResolvedDictionary;
    sourceWords: DictionaryCandidate[];
    /** `global.suggest.restatedIdentifiers`: `skip` (the default) adds no meaning a plain code name only restates. */
    restatedIdentifiers?: "skip" | "mark";
}

/** The text of each context file and note of a meeting, with a short name for a quote's source. */
function contextDocuments(record: MeetingRecord): { name: string; text: string }[] {
    return record.context.flatMap((entry) => {
        if (entry.kind === "note") {
            return [{ name: entry.title ?? entry.id, text: entry.ref }];
        }

        const file = entry.kind === "file" ? contextEntryText(entry, record) : undefined;
        return file ? [{ name: entry.title ?? basename(entry.ref, extname(entry.ref)), text: file.text }] : [];
    });
}

/**
 * The passages read aloud from a context document (a quote of its line) and the spoken paths and identifiers (a
 * meaning after the words). An identifier inside a quoted passage is left to the quote.
 */
function documentItems(options: TermSources, docs: ReturnType<typeof contextDocuments>): NewItem[] {
    if (docs.length === 0) {
        return [];
    }

    const entries = options.meeting.transcript;
    const labels = options.sourceLabels ?? { readAloudLabel: "čte z", lineLabel: "ř." };
    const quotes = findReadAloud({ entries, lines: docs.flatMap((doc) => docLines(doc.name, doc.text)) });
    const spoken = findSpokenIdentifiers({ entries, identifiers: docs.flatMap((doc) => docIdentifiers(doc.text)) });
    const inQuote = (entry: number, start: number, end: number) =>
        quotes.some((quote) => quote.entry === entry && quote.start < end && start < quote.end);
    const atSec = (entry: number) => entries[entry]?.startSec;

    return [
        ...quotes.flatMap((quote): NewItem[] => {
            const at = atSec(quote.entry);
            return at === undefined
                ? []
                : [
                      {
                          kind: "term",
                          status: "suggested",
                          heard: quote.heard,
                          atSec: at,
                          quote: {
                              text: quote.text,
                              source: `${labels.readAloudLabel} ${quote.doc}, ${labels.lineLabel} ${quote.line}`,
                          },
                          confidence: Math.min(0.95, quote.score),
                          rules: [MeetingRule.ReadAloud],
                          evidence: {
                              doc: quote.doc,
                              line: quote.line,
                              shared: quote.shared,
                              transcriptLine: quote.entry,
                          },
                      },
                  ];
        }),
        ...spoken.flatMap((match): NewItem[] => {
            const at = atSec(match.entry);
            const restated =
                options.restatedIdentifiers !== "mark" && restatesSpokenWords(match.heard, match.identifier);
            return at === undefined || restated || inQuote(match.entry, match.start, match.end)
                ? []
                : [
                      {
                          kind: "term",
                          status: "suggested",
                          heard: match.heard,
                          atSec: at,
                          meaning: match.identifier,
                          confidence: Math.min(0.9, 0.5 + 0.1 * match.matched),
                          rules: [MeetingRule.SpokenIdentifier],
                          evidence: { matched: match.matched, of: match.score, transcriptLine: match.entry },
                      },
                  ];
        }),
    ];
}

/** The terms a meeting's transcript should contain: glossary, source dictionary, own dictionary, names, context. */
function termVocabulary(options: TermSources, docs: ReturnType<typeof contextDocuments>): VocabTerm[] {
    const { record, dictionary } = options;
    const dictionaryTerms = dictionary.entries.flatMap((entry) => {
        if (entry.type === "term") {
            return [{ term: entry.value, source: "dictionary" }];
        }

        return entry.type === "fix" ? [{ term: entry.substitution, source: "dictionary" }] : [];
    });

    return scopedVocabulary({
        dictionary: dictionaryTerms,
        context: docs.flatMap((doc) => termsFromText(doc.text, "context")),
        user: options.sourceWords.map((word) => ({ term: word.replacement ?? word.value, source: "source" })),
        people: record.participants.flatMap((person) => [person.name, ...person.name.split(/\s+/)]),
    });
}

/** The term part of `evidence --raw`: the same vocabulary as the term rules, with no threshold of their own. */
export function rawTerms(
    options: TermSources & { wordCheck?: WordCheck; unavailable?: string }
): RawTermEvidence & { documents: DocumentEvidence } {
    const docs = contextDocuments(options.record);
    return {
        ...rawTermEvidence({
            entries: options.meeting.transcript,
            vocab: termVocabulary(options, docs),
            context: termsFromText(options.meeting.title, "title"),
            wordCheck: options.wordCheck,
            unavailable: options.unavailable,
        }),
        documents: documentEvidence(options, docs),
    };
}

/** The candidates the document rules see, as facts for an agent: where a line is read aloud, where an identifier is said. */
export interface DocumentEvidence {
    readAloud: Array<{ atSec?: number; heard: string; doc: string; line: number; text: string; score: number }>;
    identifiers: Array<{ atSec?: number; heard: string; identifier: string; matched: number }>;
}

function documentEvidence(options: TermSources, docs: ReturnType<typeof contextDocuments>): DocumentEvidence {
    const entries = options.meeting.transcript;

    return {
        readAloud: findReadAloud({ entries, lines: docs.flatMap((doc) => docLines(doc.name, doc.text)) }).map(
            (match) => ({
                atSec: entries[match.entry]?.startSec,
                heard: match.heard,
                doc: match.doc,
                line: match.line,
                text: match.text,
                score: match.score,
            })
        ),
        identifiers: findSpokenIdentifiers({
            entries,
            identifiers: docs.flatMap((doc) => docIdentifiers(doc.text)),
        }).map((match) => ({
            atSec: entries[match.entry]?.startSec,
            heard: match.heard,
            identifier: match.identifier,
            matched: match.matched,
        })),
    };
}

/**
 * The suggested term items a dictionary entry or the slang rule now settles, and the open questions that decide only
 * those: a later `suggest` retires them (MC5: a `keep` entry added after a run still left its word asked).
 */
export function settledTermItems(options: {
    record: MeetingRecord;
    dictionary: Pick<ResolvedDictionary, "entries">;
    known?: (word: string) => boolean;
    /** A form heard this often is asked in the group `words`, never retired as said on purpose (default 2). */
    minOccurrences?: number;
    unknownCandidate?: number;
}): Map<string, string> {
    const { record } = options;
    const keep = dictionaryKeeps(options.dictionary);
    const keptFamilies = new Set([...keep].map(wordFamily));
    const terms = record.items.filter(
        (item): item is Extract<MeetingItem, { kind: "term" }> => item.kind === "term" && item.status === "suggested"
    );
    const unknownWords = terms.filter((item) => item.rules.includes(MeetingRule.UnknownWord)).map((item) => item.heard);
    const onPurpose = spokenOnPurpose(unknownWords, options.known ?? isEnglishWord);
    const settled = new Map<string, string>();

    for (const item of terms) {
        const heard = item.heard.toLowerCase();

        if (keep.has(heard)) {
            settled.set(item.id, `the dictionary settles "${item.heard}"`);
        } else if (item.rules.includes(MeetingRule.UnknownWord) && keptFamilies.has(wordFamily(item.heard))) {
            settled.set(item.id, `the dictionary keeps a form of "${item.heard}"`);
        } else if (
            item.rules.includes(MeetingRule.UnknownWord) &&
            onPurpose.has(heard) &&
            heardTimes(item) < (options.minOccurrences ?? DEFAULT_WORD_MIN_OCCURRENCES) &&
            !strongMeetingCandidate(item.heard, item.evidence, options.unknownCandidate ?? 0.8)
        ) {
            settled.set(item.id, `"${item.heard}" is said on purpose (a word family or an English root)`);
        }
    }

    for (const item of record.items) {
        if (
            item.kind === "question" &&
            item.status === "suggested" &&
            item.decides.length > 0 &&
            item.decides.every((id) => settled.has(id))
        ) {
            settled.set(item.id, "every item it decides is settled");
        }
    }

    return settled;
}

export interface TermThresholds {
    phonetic: number;
    unknownCandidate: number;
}

export function termItems(
    options: TermSources & {
        wordCheck?: WordCheck;
        wordQuestions?: { minOccurrences: number };
        termThresholds?: TermThresholds;
    }
): NewItem[] {
    const { meeting, dictionary, wordCheck } = options;
    const docs = contextDocuments(options.record);
    const vocab = termVocabulary(options, docs);
    // A word the dictionary keeps, or already replaces (a fix, a term's spoken form), needs no item and no question.
    const keep = dictionaryKeeps(dictionary);
    const context = termsFromText(meeting.title, "title");
    const unknownCandidate = (options.termThresholds?.unknownCandidate ?? 0.8) * 100;
    const suspects = findSuspectTerms({
        entries: meeting.transcript,
        vocab,
        context,
        wordCheck,
        minConfidence: options.termThresholds && options.termThresholds.phonetic * 100,
    }).filter((suspect) => !keep.has(suspect.heard.toLowerCase()));
    const heardUnknown = wordCheck
        ? findUnknownWords({
              entries: meeting.transcript,
              vocab,
              wordCheck,
              context,
              skip: new Set([...keep, ...suspects.map((suspect) => suspect.heard.toLowerCase())]),
          })
        : [];
    // A keep entry covers the forms of its word ("mokovaný" keeps "mokovanejm" too), and slang is said on purpose,
    // unless the form itself repeats: then it is asked in the group `words` (W5: two forms can be two terms).
    const minOccurrences = options.wordQuestions?.minOccurrences ?? DEFAULT_WORD_MIN_OCCURRENCES;
    const keptFamilies = new Set([...keep].map(wordFamily));
    const onPurpose = spokenOnPurpose(
        heardUnknown.map((word) => word.heard),
        knownWord(wordCheck)
    );
    const unknown = heardUnknown.filter(
        (word) =>
            (word.candidates.some(
                (candidate) =>
                    candidate.confidence >= unknownCandidate &&
                    (candidate.source === "meeting" || acronymStem(word.heard))
            ) ||
                !onPurpose.has(word.heard.toLowerCase()) ||
                word.occurrences >= minOccurrences) &&
            !keptFamilies.has(wordFamily(word.heard))
    );
    log.debug(
        {
            vocab: vocab.length,
            suspects: suspects.length,
            unknown: unknown.length,
            onPurpose: onPurpose.size,
            kept: keep.size,
        },
        "term suggestions"
    );

    // R2.5: a word close to a term or its spoken form, below the score that replaces it silently.
    const applyAt = (dictionary.fuzzy ?? DEFAULT_FUZZY).apply;
    const fuzzy = new Map<
        string,
        { heard: string; value: string; score: number; atSec?: number; line?: number; occurrences: number }
    >();

    for (const match of fuzzyMatches(meeting.transcript, dictionary).filter(
        (candidate) =>
            candidate.score < applyAt &&
            !keep.has(candidate.heard.toLowerCase()) &&
            (!wordCheck || allowsFuzzyTerm(candidate.heard, wordCheck))
    )) {
        const key = `${match.heard.toLowerCase()}|${match.value}`;
        const seen = fuzzy.get(key);
        fuzzy.set(key, {
            heard: match.heard,
            value: match.value,
            score: match.score,
            atSec: seen?.atSec ?? meeting.transcript[match.line]?.startSec,
            line: seen ? seen.line : match.line,
            occurrences: (seen?.occurrences ?? 0) + 1,
        });
    }

    const fuzzyItems: NewItem[] = [...fuzzy.values()].map((match) => ({
        kind: "term",
        status: "suggested",
        heard: match.heard,
        proposed: match.value,
        ...(match.atSec !== undefined ? { atSec: match.atSec } : {}),
        confidence: Math.round(match.score * 100) / 100,
        rules: [MeetingRule.DictionaryFuzzy],
        evidence: {
            occurrences: match.occurrences,
            ...(match.atSec !== undefined && match.line !== undefined ? { transcriptLine: match.line } : {}),
        },
    }));

    return [
        ...documentItems(options, docs),
        ...fuzzyItems,
        ...suspects.flatMap((suspect) => {
            // A code name or another case of the same word keeps the heard words: no replacement to suggest.
            const best = suspect.candidates.find((candidate) => !keepsHeardWords(suspect.heard, candidate));

            if (!best) {
                return [];
            }

            return [
                {
                    kind: "term" as const,
                    status: "suggested" as const,
                    heard: suspect.heard,
                    proposed: best.term,
                    ...(suspect.examples[0]?.atSec !== undefined ? { atSec: suspect.examples[0].atSec } : {}),
                    confidence: best.confidence / 100,
                    rules: [MeetingRule.PhoneticTerm, ...(suspect.needsConfirmation ? [MeetingRule.SummaryName] : [])],
                    evidence: {
                        source: best.source,
                        candidateSources: suspect.candidates.map((candidate) => ({
                            term: candidate.term,
                            source: candidate.source,
                        })),
                        occurrences: suspect.occurrences,
                        examples: suspect.examples,
                        match: suspect.kind,
                        candidates: suspect.candidates.map(
                            (candidate) => `${candidate.term} ${candidate.confidence} %`
                        ),
                        candidateScores: candidateScoresOf(suspect.candidates),
                    },
                },
            ];
        }),
        // Weak phonetic matches remain evidence; an observed one-edit match can be proposed.
        ...unknown.map((word): NewItem => {
            const proposed = word.candidates.find((candidate) => candidate.confidence >= unknownCandidate);
            return {
                kind: "term",
                status: "suggested",
                heard: word.heard,
                ...(proposed ? { proposed: proposed.term } : {}),
                ...(word.examples[0]?.atSec !== undefined ? { atSec: word.examples[0].atSec } : {}),
                confidence: proposed ? proposed.confidence / 100 : UNKNOWN_WORD_CONFIDENCE,
                rules: [MeetingRule.UnknownWord],
                evidence: {
                    occurrences: word.occurrences,
                    examples: word.examples,
                    verdict: word.verdict,
                    wordCheck: wordCheck?.provider,
                    candidateSources: word.candidates.map((candidate) => ({
                        term: candidate.term,
                        source: candidate.source,
                    })),
                    candidates: word.candidates.map((candidate) => `${candidate.term} ${candidate.confidence} %`),
                    candidateScores: candidateScoresOf(word.candidates),
                },
            };
        }),
    ];
}

/**
 * A term's candidates typed, each with its confidence 0 to 1 as an item's (WaveB-Plan decision 7): a review row shows
 * them on its choices. `candidates` keeps the "EMP 82 %" strings older readers print.
 */
function candidateScoresOf(candidates: Array<{ term: string; confidence: number }>) {
    return candidates.map((candidate) => ({ term: candidate.term, confidence: candidate.confidence / 100 }));
}
