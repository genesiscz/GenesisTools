import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingItem, type MeetingRecord, meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { DictionaryCandidate, MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { DEFAULT_FUZZY, fuzzyMatches, type ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import { docIdentifiers, docLines, findReadAloud, findSpokenIdentifiers } from "@genesiscz/utils/transcribe/doc-match";
import { type LineEvidence, lineEvidence, SELF } from "@genesiscz/utils/transcribe/evidence";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import {
    PRESENCE_TOLERANCE_SEC,
    type Presence,
    type SpeakerHint,
    sameName,
    speakerStats,
} from "@genesiscz/utils/transcribe/speakers";
import type { SummaryPoint } from "@genesiscz/utils/transcribe/summary";
import {
    buildVocabulary,
    DEV_GLOSSARY,
    findSuspectTerms,
    findUnknownWords,
    type RawTermEvidence,
    rawTermEvidence,
    termsFromText,
    type VocabTerm,
} from "@genesiscz/utils/transcribe/terms";
import { arrivalItems } from "./arrival";
import { selectQuestions } from "./question-select";
import { DEFAULT_LISTEN_BELOW, questionFor, questionKey } from "./questions";

const { log } = logger.scoped("meetings-suggest");

export const SUGGEST_RULES = ["speakers", "evidence", "terms"] as const;
export type SuggestRule = (typeof SUGGEST_RULES)[number];

export function isSuggestRule(value: string): value is SuggestRule {
    return (SUGGEST_RULES as readonly string[]).includes(value);
}

/** Confidence per rule, 0 to 1. RA is attendance (evidence); a goodbye nobody answered is only an intention. */
const CONFIDENCE = {
    attendance: 0.95,
    join: 0.9,
    answeredLeave: 0.75,
    unansweredLeave: 0.4,
    llmBonus: 0.1,
    /** A word no dictionary layer knows and no term matches: probably misheard, but into what is open. */
    unknownWord: 0.3,
} as const;

/** `Omit` applied to each member of a union, so each kind keeps its own fields. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An item before it has an id and a time. */
type NewItem = OmitEach<MeetingItem, "id" | "suggestedAt">;

/** Turns the speaker hints into items. A hint without a time range (several people) gives none. */
function speakerItems(options: {
    hints: SpeakerHint[];
    selfName: string | undefined;
    selfAttendee: string | undefined;
    lastSecOf: Map<string, number>;
    /** Who named each label: a platform names the person, so attendance can tell whether they are still there. */
    originOf: Map<string, string | undefined>;
    presence: Presence[] | undefined;
}): NewItem[] {
    const { hints, selfName, lastSecOf } = options;
    const items: NewItem[] = [];
    // The platform may name the recording user by email; the record knows their name.
    const speakerName = (attendee: string) => (attendee === options.selfAttendee && selfName ? selfName : attendee);

    for (const hint of hints) {
        if (hint.kind === "absent-speaker") {
            for (const range of hint.ranges) {
                items.push({
                    kind: "speaker-range",
                    status: "suggested",
                    label: hint.label,
                    fromSec: range.fromSec,
                    toSec: range.toSec,
                    // One person in the call: the voice is that person (the same item as a sole-attendee hint).
                    ...(range.present?.length === 1
                        ? { speaker: speakerName(range.present[0]!) }
                        : range.present
                          ? { candidates: range.present }
                          : {}),
                    confidence: CONFIDENCE.attendance,
                    rules: [MeetingRule.Attendance],
                    evidence: { lines: range.lines, reason: `${hint.label} was not in the call` },
                });
            }
        } else if (hint.kind === "sole-attendee") {
            const speaker = speakerName(hint.person);

            for (const range of hint.ranges) {
                items.push({
                    kind: "speaker-range",
                    status: "suggested",
                    label: hint.label,
                    fromSec: range.fromSec,
                    toSec: range.toSec,
                    speaker,
                    confidence: CONFIDENCE.attendance,
                    rules: [MeetingRule.Attendance],
                    evidence: { lines: range.lines, reason: `only ${hint.person} was in the call` },
                });
            }
        } else if (hint.kind === "leave-then-continues") {
            hint.leaves.forEach((leave, index) => {
                const until = hint.leaves[index + 1]?.atSec ?? lastSecOf.get(hint.label) ?? leave.continuesAtSec;
                const answered = Boolean(leave.confirmedBy || leave.echoOf);
                const base = answered ? CONFIDENCE.answeredLeave : CONFIDENCE.unansweredLeave;
                // A platform names the label after the person: while attendance shows them in the call through
                // the range, their goodbye was only an intention and the lines after it are still theirs.
                const stillThere =
                    options.originOf.get(hint.label) === "platform" &&
                    options.presence?.some(
                        (stay) =>
                            sameName(stay.name, hint.label) &&
                            stay.fromSec <= leave.continuesAtSec &&
                            stay.toSec >= until - PRESENCE_TOLERANCE_SEC
                    );

                if (stillThere) {
                    return;
                }

                items.push({
                    kind: "speaker-range",
                    status: "suggested",
                    label: hint.label,
                    fromSec: leave.continuesAtSec,
                    toSec: until,
                    confidence: Math.min(1, base + (hint.strength === "strong" ? CONFIDENCE.llmBonus : 0)),
                    rules: [
                        MeetingRule.LeavePhrase,
                        MeetingRule.ContinuesAfterLeave,
                        ...(leave.confirmedBy ? [MeetingRule.FarewellAnswered] : []),
                        ...(leave.echoOf ? [MeetingRule.EchoedFarewell] : []),
                    ],
                    evidence: {
                        leaveAt: leave.atSec,
                        said: leave.text,
                        // Nobody answered the goodbye: maybe only an intention, so it is kept but never asked by ear.
                        ...(answered ? {} : { intention: true }),
                        ...(leave.confirmedBy ? { answeredBy: leave.confirmedBy } : {}),
                        ...(leave.echoOf ? { notThisPerson: leave.echoOf.label } : {}),
                    },
                });
            });
        } else if (hint.kind === "split-voice" && hint.join) {
            items.push({
                kind: "join",
                status: "suggested",
                atSec: hint.join.atSec,
                speaker: hint.neighbour,
                joined: hint.join.joined,
                confidence: CONFIDENCE.join,
                rules: ["split-word", "lone-label"],
                evidence: { label: hint.label, left: hint.join.left, right: hint.join.right },
            });
        }
    }

    return items;
}

interface TermSources {
    meeting: SourceMeeting;
    record: MeetingRecord;
    /** How a quote names its source (`global.render`): "(čte z WikiProposals, ř. 33)". */
    sourceLabels?: { readAloudLabel: string; lineLabel: string };
    dictionary: ResolvedDictionary;
    sourceWords: DictionaryCandidate[];
}

/** The text of each context file and note of a meeting, with a short name for a quote's source. */
function contextDocuments(record: MeetingRecord): { name: string; text: string }[] {
    return record.context.flatMap((entry) => {
        if (entry.kind === "note") {
            return [{ name: entry.title ?? entry.id, text: entry.ref }];
        }

        return entry.kind === "file" && existsSync(entry.ref)
            ? [{ name: entry.title ?? basename(entry.ref, extname(entry.ref)), text: readFileSync(entry.ref, "utf8") }]
            : [];
    });
}

/**
 * The passages read aloud from a context document (a quote of its line) and the spoken paths and identifiers (a
 * meaning after the words). An identifier inside a quoted passage is left to the quote.
 */
function documentItems(options: TermSources): NewItem[] {
    const docs = contextDocuments(options.record);

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
                          evidence: { doc: quote.doc, line: quote.line, shared: quote.shared },
                      },
                  ];
        }),
        ...spoken.flatMap((match): NewItem[] => {
            const at = atSec(match.entry);
            return at === undefined || inQuote(match.entry, match.start, match.end)
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
                          evidence: { matched: match.matched, of: match.score },
                      },
                  ];
        }),
    ];
}

/** The terms a meeting's transcript should contain: glossary, source dictionary, own dictionary, names, context. */
function termVocabulary(options: TermSources): VocabTerm[] {
    const { record, dictionary } = options;
    const contextTexts = record.context.map((entry) => {
        if (entry.kind === "note") {
            return termsFromText(entry.ref, "context");
        }

        return entry.kind === "file" && existsSync(entry.ref)
            ? termsFromText(readFileSync(entry.ref, "utf8"), "context")
            : [];
    });
    const dictionaryTerms = dictionary.entries.flatMap((entry) => {
        if (entry.type === "term") {
            return [{ term: entry.value, source: "dictionary" }];
        }

        return entry.type === "fix" ? [{ term: entry.substitution, source: "dictionary" }] : [];
    });

    return buildVocabulary([
        DEV_GLOSSARY.map((term) => ({ term, source: "glossary" })),
        options.sourceWords.map((word) => ({ term: word.replacement ?? word.value, source: "source" })),
        dictionaryTerms,
        // People's names, whole and by part, so "Tomášem" is a name and not an unknown word.
        record.participants.flatMap((person) =>
            [person.name, ...person.name.split(/\s+/)].map((term) => ({ term, source: "participant" }))
        ),
        ...contextTexts,
    ]);
}

/** The term part of `evidence --raw`: the same vocabulary as the term rules, with no threshold of their own. */
export function rawTerms(options: TermSources & { wordCheck?: WordCheck; unavailable?: string }): RawTermEvidence {
    return rawTermEvidence({
        entries: options.meeting.transcript,
        vocab: termVocabulary(options),
        context: termsFromText(options.meeting.title, "title"),
        wordCheck: options.wordCheck,
        unavailable: options.unavailable,
    });
}

function termItems(options: TermSources & { wordCheck?: WordCheck }): NewItem[] {
    const { meeting, dictionary, wordCheck } = options;
    const vocab = termVocabulary(options);
    // A word the dictionary keeps, or already replaces (a fix, a term's spoken form), needs no item and no question.
    const keep = new Set(
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
    const context = termsFromText(meeting.title, "title");
    const suspects = findSuspectTerms({ entries: meeting.transcript, vocab, context, wordCheck }).filter(
        (suspect) => !keep.has(suspect.heard.toLowerCase())
    );
    const unknown = wordCheck
        ? findUnknownWords({
              entries: meeting.transcript,
              vocab,
              wordCheck,
              context,
              skip: new Set([...keep, ...suspects.map((suspect) => suspect.heard.toLowerCase())]),
          })
        : [];
    log.debug(
        { vocab: vocab.length, suspects: suspects.length, unknown: unknown.length, kept: keep.size },
        "term suggestions"
    );

    // R2.5: a word close to a term or its spoken form, below the score that replaces it silently.
    const applyAt = (dictionary.fuzzy ?? DEFAULT_FUZZY).apply;
    const fuzzy = new Map<
        string,
        { heard: string; value: string; score: number; atSec?: number; occurrences: number }
    >();

    for (const match of fuzzyMatches(meeting.transcript, dictionary).filter(
        (candidate) => candidate.score < applyAt && !keep.has(candidate.heard.toLowerCase())
    )) {
        const key = `${match.heard.toLowerCase()}|${match.value}`;
        const seen = fuzzy.get(key);
        fuzzy.set(key, {
            heard: match.heard,
            value: match.value,
            score: match.score,
            atSec: seen?.atSec ?? meeting.transcript[match.line]?.startSec,
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
        evidence: { occurrences: match.occurrences },
    }));

    return [
        ...documentItems(options),
        ...fuzzyItems,
        ...suspects.flatMap((suspect) => {
            const best = suspect.candidates[0];

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
                        occurrences: suspect.occurrences,
                        examples: suspect.examples,
                        match: suspect.kind,
                        candidates: suspect.candidates.map(
                            (candidate) => `${candidate.term} ${candidate.confidence} %`
                        ),
                    },
                },
            ];
        }),
        ...unknown.map((word): NewItem => {
            const best = word.candidates[0];

            return {
                kind: "term",
                status: "suggested",
                heard: word.heard,
                ...(best ? { proposed: best.term } : {}),
                ...(word.examples[0]?.atSec !== undefined ? { atSec: word.examples[0].atSec } : {}),
                confidence: CONFIDENCE.unknownWord,
                rules: [MeetingRule.UnknownWord],
                evidence: {
                    occurrences: word.occurrences,
                    examples: word.examples,
                    verdict: word.verdict,
                    wordCheck: wordCheck?.provider,
                    candidates: word.candidates.map((candidate) => `${candidate.term} ${candidate.confidence} %`),
                },
            };
        }),
    ];
}

/** A line counts as one channel when that channel holds at least this share of it (rule E1). */
const CHANNEL_SHARE = 0.9;
/** Lines of one label closer than this, with the same finding, form one item. */
const EVIDENCE_GAP_SEC = 120;

interface EvidenceFinding {
    speaker?: string;
    candidates?: string[];
    rules: string[];
    confidence: number;
    /** Both channels are in the line: a person should listen before confirming. */
    listen?: boolean;
    /** The microphone heard the call's own words (rule R2.1 echo). */
    echo?: boolean;
}

/** The microphone alone never proves the user spoke (Martin, 2026-11-02): loud speakers can reach it. */
const MIC_ALONE_MAX = 0.95;
const MIC_WITH_ENERGY_MAX = 0.98;
const ECHO_SIMILARITY = 0.6;
const ECHO_PENALTY = 0.3;
/** The call's share of the energy at or above this while the microphone won: someone on the call was loud too. */
const CALL_LOUD_SHARE = 0.4;
const CALL_LOUD_PENALTY = 0.15;
const ENERGY_AGREES_SHARE = 0.75;
const ENERGY_AGREES_BONUS = 0.05;
/**
 * R4.3: the live segments are coarse (a short reply into the microphone inside a long call segment counts as the
 * call's), so an energy share this sure of one channel beats them. It exists only with a calibrated layout.
 */
const ENERGY_MIC_SURE = 0.9;
const ENERGY_CALL_SURE = 0.1;
const ENERGY_SURE_CONFIDENCE = 0.85;
/** The energy says the microphone while the segments said the call: both voices may be in the line. */
const ENERGY_OVER_SEGMENTS_CONFIDENCE = 0.75;
/**
 * Where the segments are mixed (neither channel holds `CHANNEL_SHARE`), the energy's majority decides: this much on
 * the microphone is the user, unsure enough to ask; under `ENERGY_CALL_LEANS` it is not the user.
 */
const ENERGY_MIC_LEANS = 0.7;
const ENERGY_CALL_LEANS = 0.5;
const ENERGY_LEANS_CONFIDENCE = 0.55;
/** A mixed line under a platform label whose person E3 alone shows speaking stays the label's below this energy. */
const ENERGY_LABEL_HOLDS = 0.8;
/** R17: a platform-named label with a line this close to another label's line is talking in the same dialogue. */
const OWN_LABEL_SEC = 10;
const OWN_LABEL_CONFIDENCE = 0.65;

/**
 * How sure a microphone-won line is the user: the microphone's share, at most 0.95; less when the microphone heard
 * the call's own words (echo) or the call was loud at the same time; a little more when the energy agrees.
 */
function micConfidence(line: LineEvidence): {
    confidence: number;
    echo: boolean;
    callLoud: boolean;
    energyChecked: boolean;
} {
    const echo = (line.echo ?? 0) >= ECHO_SIMILARITY;
    const callLoud = line.energyMic !== undefined && 1 - line.energyMic >= CALL_LOUD_SHARE;
    const agrees = line.energyMic !== undefined && line.energyMic >= ENERGY_AGREES_SHARE;
    let confidence = Math.min(MIC_ALONE_MAX, line.micShare ?? 0);

    confidence -= echo ? ECHO_PENALTY : 0;
    confidence -= callLoud ? CALL_LOUD_PENALTY : 0;
    confidence += agrees ? ENERGY_AGREES_BONUS : 0;

    return {
        confidence: Math.max(0, Math.min(MIC_WITH_ENERGY_MAX, confidence)),
        echo,
        callLoud,
        energyChecked: line.energyMic !== undefined,
    };
}

/** The names the platform showed speaking during a line, most often first. */
function speakingNames(line: LineEvidence): string[] {
    return Object.entries(line.speaking)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
}

/**
 * Rule E1 with E3 and E4: what the audio channel says about one line.
 * - The user's microphone under another label: the line is the user.
 * - The call's sound under the user's label: someone else; the platform's speaking indicator (E3) and live name (E4)
 *   name them when they agree, else the people in the call are the candidates.
 * - The call's sound under another label whose live name and speaking indicator agree on a different person.
 */
function findingFor(options: {
    line: LineEvidence;
    selfName: string;
    isSelfLabel: boolean;
    /** The platform-named labels other than this line's that have a line within `OWN_LABEL_SEC` of it (R17). */
    ownLabelNearby: string[];
    /** The platform named the line's label after a person. */
    platformLabel: boolean;
}): EvidenceFinding | undefined {
    const { line, selfName, isSelfLabel, ownLabelNearby } = options;

    // No live segment covers the line, or two tie: only a sure energy share names its channel.
    if (line.micShare === undefined || !line.winner) {
        const micSure = line.energyMic !== undefined && line.energyMic >= ENERGY_MIC_SURE;

        return micSure && !isSelfLabel
            ? { speaker: selfName, rules: [MeetingRule.Energy], confidence: ENERGY_OVER_SEGMENTS_CONFIDENCE }
            : undefined;
    }

    // RM: a person muted through the whole line did not speak it.
    const muted = (name: string) => line.muted?.some((person) => sameName(person, name)) === true;
    const selfMuted = muted(selfName);

    // R4.3: a sure energy share is the user's line whatever the segments, E3 or E4 say, and never the user's below.
    // Where the segments are mixed, the energy's majority decides the same way.
    const energy = line.energyMic;
    const mixed = line.micShare > 1 - CHANNEL_SHARE && line.micShare < CHANNEL_SHARE;
    const micSure = energy !== undefined && energy >= ENERGY_MIC_SURE;
    const micLeans = mixed && energy !== undefined && energy >= ENERGY_MIC_LEANS;
    const callSure = energy !== undefined && (energy <= ENERGY_CALL_SURE || (mixed && energy < ENERGY_CALL_LEANS));

    // The platform's label and its speaking indicator agree on the label's person: a microphone lean does not win.
    const shown = speakingNames(line).filter((name) => !sameName(name, selfName) && !muted(name));
    const labelShownAlone =
        options.platformLabel && !isSelfLabel && shown.length === 1 && sameName(shown[0]!, line.label);

    if (labelShownAlone && mixed && energy !== undefined && energy < ENERGY_LABEL_HOLDS) {
        return undefined;
    }

    if ((micSure || micLeans) && line.winner !== SELF) {
        return isSelfLabel
            ? undefined
            : {
                  speaker: selfName,
                  rules: [MeetingRule.Energy],
                  confidence: micSure ? ENERGY_OVER_SEGMENTS_CONFIDENCE : ENERGY_LEANS_CONFIDENCE,
                  ...(mixed ? { listen: true } : {}),
              };
    }

    // Wispr records the microphone itself, so a user muted in the call can still be heard on it: RM never overrules a
    // line the microphone won, only one the call's sound won.
    if (line.winner === SELF && !callSure) {
        if (isSelfLabel) {
            return undefined;
        }

        const mic = micConfidence(line);
        return {
            speaker: selfName,
            rules: mic.energyChecked ? [MeetingRule.Channel, MeetingRule.Energy] : [MeetingRule.Channel],
            confidence: micSure ? Math.max(ENERGY_SURE_CONFIDENCE, mic.confidence) : mic.confidence,
            ...(mic.echo ? { echo: true } : {}),
            ...(line.micShare < CHANNEL_SHARE || mic.echo || mic.callLoud ? { listen: true } : {}),
        };
    }

    // The call's sound won the line, or the energy says it did. Some microphone in it means two voices: listen.
    const channel = line.winner === SELF ? MeetingRule.Energy : MeetingRule.Channel;
    const listen = line.micShare > 1 - CHANNEL_SHARE ? { listen: true } : {};
    const present = line.present?.filter((name) => !sameName(name, selfName) && !muted(name));
    const live =
        line.liveName && !muted(line.liveName) && (!present || present.some((name) => sameName(name, line.liveName!)))
            ? line.liveName
            : undefined;
    const agreed = live && shown[0] && sameName(shown[0], live) ? live : undefined;
    const labelMuted = !isSelfLabel && muted(line.label);
    // RM with E3: once the muted are out, the one person the indicator shows among those present said it.
    const onlyShown = present && shown.length > 0 ? shown.filter((name) => present.some((p) => sameName(p, name))) : [];
    const rmShown = (isSelfLabel ? selfMuted : labelMuted) && onlyShown.length === 1 ? onlyShown[0] : undefined;

    if (rmShown && !sameName(rmShown, line.label)) {
        return {
            speaker: rmShown,
            rules: [channel, MeetingRule.Muted, MeetingRule.SpeakingIndicator],
            confidence: 0.9,
            ...listen,
        };
    }

    // R17: of the people E3 shows, one who talks under their own label right now is the other side of the dialogue.
    const elsewhere = shown.filter((name) => ownLabelNearby.some((label) => sameName(label, name)));
    const others = shown.filter((name) => !elsewhere.includes(name));
    const other = others.length === 1 && elsewhere.length > 0 ? others[0] : undefined;

    if (other && (!present || present.some((name) => sameName(name, other)))) {
        return sameName(other, line.label)
            ? undefined
            : {
                  speaker: other,
                  rules: [channel, MeetingRule.SpeakingIndicator, MeetingRule.OwnLabel],
                  confidence: OWN_LABEL_CONFIDENCE,
                  ...listen,
              };
    }

    if (isSelfLabel) {
        const rm = selfMuted ? [MeetingRule.Muted] : [];
        return agreed
            ? {
                  speaker: agreed,
                  rules: [channel, ...rm, MeetingRule.SpeakingIndicator, MeetingRule.LiveName],
                  confidence: selfMuted ? 0.85 : 0.8,
                  ...listen,
              }
            : { candidates: present ?? shown, rules: [channel, ...rm], confidence: 0.6, ...listen };
    }

    if (labelMuted && !agreed) {
        const candidates = (present ?? shown).filter((name) => !sameName(name, line.label));
        return { candidates, rules: [channel, MeetingRule.Muted], confidence: 0.5, ...listen };
    }

    // A label the platform named after a person is its own voice id: E3 and E4 agreeing on another never move it.
    if (agreed && !sameName(agreed, line.label) && !options.platformLabel) {
        return {
            speaker: agreed,
            rules: [channel, MeetingRule.SpeakingIndicator, MeetingRule.LiveName],
            confidence: 0.7,
            ...listen,
        };
    }

    // RA: the label's own person was not in the call, so the platform's live name is the best guess left.
    const labelAbsent = present !== undefined && !present.some((name) => sameName(name, line.label));

    // E4 is the weakest: when the speaking indicator shows people and not the live name, E4 loses.
    const indicatorAgrees = shown.length === 0 || shown.some((name) => sameName(name, live ?? ""));

    if (labelAbsent && live && indicatorAgrees) {
        return {
            speaker: live,
            rules: [channel, MeetingRule.LiveName, MeetingRule.Attendance],
            confidence: 0.6,
            ...listen,
        };
    }

    // The live name belongs to someone who had left: a live voice id keeps its last name after the person goes.
    // The speaking indicator among the people still in the call is the guess, sampled only every few seconds.
    const stillHere = shown.filter((name) => present?.some((person) => sameName(person, name)));

    if (labelAbsent && line.liveName && stillHere[0]) {
        return {
            speaker: stillHere[0],
            rules: [channel, MeetingRule.SpeakingIndicator, MeetingRule.Attendance],
            confidence: 0.45,
            listen: true,
        };
    }

    return undefined;
}

function evidenceItems(options: {
    meeting: SourceMeeting;
    evidence: MeetingEvidence;
    presence?: Presence[];
    energyMicShare?: (fromSec: number, toSec: number) => number | undefined;
}): NewItem[] {
    const selfName = options.evidence.selfName;

    if (!selfName || options.evidence.segments.length === 0) {
        log.debug({ selfName, segments: options.evidence.segments.length }, "no channel evidence");
        return [];
    }

    // Teams attendance names the user by email; here the user is always `selfName`.
    const presence = options.presence?.map((stay) => (stay.self ? { ...stay, name: selfName } : stay));
    const lines = lineEvidence(options.meeting.transcript, options.evidence, presence, options.energyMicShare);
    const items: NewItem[] = [];
    let open:
        | {
              item: Extract<NewItem, { kind: "speaker-range" }>;
              key: string;
              shares: number[];
              echoLines: number;
              endSec: number;
          }
        | undefined;
    const close = () => {
        if (open) {
            const mean = open.shares.reduce((sum, share) => sum + share, 0) / open.shares.length;
            open.item.confidence = Math.round(mean * 100) / 100;
            open.item.evidence = {
                ...open.item.evidence,
                lines: open.shares.length,
                endSec: open.endSec,
                ...(open.echoLines > 0 ? { echoLines: open.echoLines } : {}),
            };
            items.push(open.item);
            open = undefined;
        }
    };
    const platformLabels = new Set(
        options.meeting.speakers.filter((speaker) => speaker.origin === "platform").map((speaker) => speaker.name)
    );
    const byLabel = new Map<string, LineEvidence[]>();

    for (const line of lines) {
        byLabel.set(line.label, [...(byLabel.get(line.label) ?? []), line]);
    }

    for (const [label, labelLines] of byLabel) {
        const isSelfLabel = sameName(label, selfName);

        for (const line of labelLines) {
            const finding = findingFor({
                line,
                selfName,
                isSelfLabel,
                platformLabel: platformLabels.has(label),
                ownLabelNearby: [
                    ...new Set(
                        lines
                            .filter(
                                (near) =>
                                    near.label !== label &&
                                    platformLabels.has(near.label) &&
                                    Math.abs(near.startSec - line.startSec) <= OWN_LABEL_SEC
                            )
                            .map((near) => near.label)
                    ),
                ],
            });

            // A range holds only consecutive lines with its finding: a line without one stays its label's.
            if (!finding) {
                close();
                continue;
            }

            const key = `${finding.speaker ?? ""}|${(finding.candidates ?? []).join(",")}|${finding.listen ? "listen" : ""}`;

            if (open && open.key === key && line.startSec - open.item.toSec < EVIDENCE_GAP_SEC) {
                open.item.toSec = line.startSec;
                open.endSec = Math.max(open.endSec, line.endSec);
                open.shares.push(finding.confidence);
                open.echoLines += finding.echo ? 1 : 0;
                continue;
            }

            close();
            open = {
                key,
                shares: [finding.confidence],
                echoLines: finding.echo ? 1 : 0,
                endSec: line.endSec,
                item: {
                    kind: "speaker-range",
                    status: "suggested",
                    label,
                    fromSec: line.startSec,
                    toSec: line.startSec,
                    ...(finding.speaker ? { speaker: finding.speaker } : {}),
                    ...(finding.candidates ? { candidates: finding.candidates } : {}),
                    confidence: finding.confidence,
                    rules: finding.rules,
                    evidence: {
                        channel: finding.speaker === selfName ? "mic" : "system",
                        ...(finding.listen
                            ? { listen: true, note: "both channels in these lines: confirm by listening" }
                            : {}),
                    },
                },
            };
        }

        close();
    }

    log.debug({ lines: lines.length, items: items.length }, "evidence items");
    return items;
}

/** Two items say the same thing: the same kind on the same label, time or word. */
function itemKey(item: NewItem | MeetingItem): string {
    if (item.kind === "speaker-range") {
        return `range|${item.label}|${Math.round(item.fromSec)}|${Math.round(item.toSec)}|${item.speaker ?? ""}`;
    }

    if (item.kind === "join") {
        return `join|${Math.round(item.atSec)}`;
    }

    if (item.kind === "question") {
        return questionKey(item);
    }

    // A quote or a meaning belongs to one place; a spelling fix to the word wherever it is heard.
    const place = item.quote || item.meaning ? `|${item.meaning ?? ""}|${Math.round(item.atSec ?? 0)}` : "";
    return `term|${item.heard.toLowerCase()}|${item.proposed ?? ""}${place}`;
}

/** Two independent rules agreeing never reach certainty: a person still confirms. */
const AGREEING_MAX = 0.95;

/** One item from two rules that found the same thing: both rules, and 1 - (1 - a)(1 - b) as the confidence. */
function agreeing(first: NewItem, second: NewItem): NewItem {
    const a = first.confidence;
    const b = second.confidence;
    const confidence =
        a === undefined || b === undefined
            ? (a ?? b)
            : Math.min(AGREEING_MAX, Math.round((1 - (1 - a) * (1 - b)) * 100) / 100);
    return {
        ...first,
        rules: [...new Set([...first.rules, ...second.rules])],
        ...(confidence === undefined ? {} : { confidence }),
        evidence: { ...second.evidence, ...first.evidence },
    };
}

/**
 * New suggestions for a meeting from its source transcript. An item the record already holds (in any status) is not
 * suggested again, so a rejected one stays rejected.
 */
export function suggestItems(options: {
    record: MeetingRecord;
    meeting: SourceMeeting;
    rules: SuggestRule[];
    dictionary: ResolvedDictionary;
    sourceWords: DictionaryCandidate[];
    presence?: Presence[];
    evidence?: MeetingEvidence | null;
    /** The microphone channel's share of the audio energy over a time range (R2.1), when the audio is at hand. */
    energyMicShare?: (fromSec: number, toSec: number) => number | undefined;
    /** Items under this confidence become questions to answer by ear, when they matter (default 0.6). */
    listenBelow?: number;
    /** The summary's action items and decisions: a range that cites one matters more. */
    points?: SummaryPoint[];
    /** At most this many questions, speakers and terms together (`playback.listen.budget`). */
    questionBudget?: number;
    /** No question under this priority (`playback.listen.minPriority`). */
    minPriority?: number;
    /** Tells ordinary words from unknown ones for the term rules; without it they skip every Czech word. */
    wordCheck?: WordCheck;
    /** How a quote names its source (`global.render`). */
    sourceLabels?: { readAloudLabel: string; lineLabel: string };
    now: string;
}): MeetingItem[] {
    const { record, meeting } = options;
    const found: NewItem[] = [];

    if (options.rules.includes("speakers")) {
        const stats = speakerStats(meeting.transcript, {
            participants: meeting.speakers,
            presence: options.presence,
        });
        const lastSecOf = new Map(stats.speakers.map((stat) => [stat.label, stat.lastSec ?? 0]));
        const selfName = record.participants.find((person) => person.self)?.name;
        const selfAttendee = options.presence?.find((stay) => stay.self)?.name;
        found.push(
            ...speakerItems({
                hints: stats.hints,
                selfName,
                selfAttendee,
                lastSecOf,
                originOf: new Map(stats.speakers.map((stat) => [stat.label, stat.origin])),
                presence: options.presence,
            })
        );
    }

    if (options.rules.includes("evidence") && options.evidence) {
        found.push(
            ...evidenceItems({
                meeting,
                evidence: options.evidence,
                presence: options.presence,
                energyMicShare: options.energyMicShare,
            }),
            ...arrivalItems({
                entries: meeting.transcript,
                lines: lineEvidence(meeting.transcript, options.evidence, options.presence),
                presence: options.presence,
                speakingReadings: options.evidence.speaking,
            })
        );
    }

    if (options.rules.includes("terms")) {
        found.push(...termItems(options));
    }

    // Two rules that reach the same item (same label, range and speaker) agree: one item with both, scored higher.
    const merged = new Map<string, NewItem>();

    for (const item of found) {
        const key = itemKey(item);
        const seen = merged.get(key);
        merged.set(key, seen ? agreeing(seen, item) : item);
    }

    const known = new Set(record.items.map(itemKey));
    const fresh: MeetingItem[] = [];
    const taken = [...record.items];

    for (const item of merged.values()) {
        const key = itemKey(item);

        if (known.has(key)) {
            continue;
        }

        known.add(key);
        const withId = meetingItemSchema.parse({ ...item, id: nextId("i", taken), suggestedAt: options.now });
        taken.push(withId);
        fresh.push(withId);
    }

    // Only the unsure items that matter become questions for `tools meetings listen`, clustered and ranked.
    const context = {
        listenBelow: options.listenBelow ?? DEFAULT_LISTEN_BELOW,
        presence: options.presence,
        selfName: record.participants.find((person) => person.self)?.name,
        transcript: meeting.transcript,
        points: options.points ?? [],
    };
    const candidates = fresh.flatMap((item) => questionFor(item, context) ?? []);

    // One budget for speakers and terms together: the most valuable first, none under the floor.
    const worth = selectQuestions(candidates, taken)
        .filter((question) => (question.priority ?? 0) >= (options.minPriority ?? 0))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .slice(0, options.questionBudget ?? Number.POSITIVE_INFINITY);

    for (const question of worth) {
        if (known.has(questionKey(question))) {
            continue;
        }

        known.add(questionKey(question));
        const asked = meetingItemSchema.parse({ ...question, id: nextId("i", taken), suggestedAt: options.now });
        taken.push(asked);
        fresh.push(asked);
    }

    return fresh;
}
