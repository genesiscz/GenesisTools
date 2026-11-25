import { SafeJSON } from "@genesiscz/utils/json";
import { languageSettings, type MeetingsConfig, resolveDictionary } from "@genesiscz/utils/meetings/config";
import type { Correction } from "@genesiscz/utils/meetings/corrections";
import {
    namesAtAnyConfidence,
    showsAsGuess,
    strongestFirst,
    strongestRange,
    weakestFirst,
} from "@genesiscz/utils/meetings/range-strength";
import type { MeetingItem, MeetingRecord } from "@genesiscz/utils/meetings/record";
import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import {
    applyCorrections,
    type CorrectionOutcome,
    type CorrectionsApplied,
    heardLineAt,
    isUnclearMarker,
    joinLine,
    type TranscriptCorrections,
    type UnclearPassage,
} from "@genesiscz/utils/transcribe/apply";
import { LINE_AT_TOLERANCE_SEC, TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import { formatClock, type TranscriptFormat } from "@genesiscz/utils/transcribe/render";
import { termFixPattern } from "@genesiscz/utils/transcribe/terms";
import type { TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { openQuestions } from "./questions";
import { needsSpeakerReview } from "./speaker-scores";
import { diagnoseTermAddress } from "./term-address";

/**
 * The open questions as passages a transcript marks: a speaker question marks the label of the ranges it decides, a
 * question with `heard` marks those words. With `applied`, an item it applies is never marked, and a speaker range
 * under `below` that no question asks is marked with its own guess.
 */
function unclearPassages(
    record: MeetingRecord,
    opts: {
        below: number;
        termBelow?: number;
        applied?: (item: MeetingItem) => boolean;
        guesses?: boolean;
        unclearLabel: string;
    }
): UnclearPassage[] {
    const applied = opts.applied ?? (() => false);
    const open = openQuestions(record);
    const asked = new Set(open.flatMap((question) => question.decides));
    const unaskedLow = (item: MeetingItem) =>
        item.status === "suggested" &&
        !applied(item) &&
        !asked.has(item.id) &&
        (needsSpeakerReview(item) ||
            (item.confidence ?? 1) < (item.kind === "term" ? (opts.termBelow ?? opts.below) : opts.below));
    // A low term the rules have a guess for is marked wherever it was heard, even unasked. An unknown word with no
    // guess is often plain spoken Czech no dictionary has ("byznysák"): it stays text unless it is asked.
    const unaskedTerms = record.items.flatMap((item): UnclearPassage[] =>
        item.kind === "term" &&
        item.proposed !== undefined &&
        !item.rules.includes(MeetingRule.UnknownWord) &&
        unaskedLow(item)
            ? [
                  {
                      fromSec: item.scope === "line" && item.atSec !== undefined ? item.atSec : 0,
                      toSec: item.scope === "line" && item.atSec !== undefined ? item.atSec : Number.POSITIVE_INFINITY,
                      heard: item.heard,
                      readings: isUnclearMarker(item.proposed, opts.unclearLabel)
                          ? [item.proposed]
                          : withConfidence([item.proposed], item.confidence),
                  },
              ]
            : []
    );
    // A range with candidates and no speaker says only that the label is wrong; it is marked at any confidence, and
    // its confidence is that the label is wrong, so no candidate carries it. A line marks once, so a range that names
    // someone goes first, the strongest of them first (a stated guess before a rule's).
    const ranges = record.items.filter(
        (item): item is Extract<MeetingItem, { kind: "speaker-range" }> => item.kind === "speaker-range"
    );
    const unaskedRanges = opts.applied
        ? [...strongestFirst(ranges.filter((item) => item.speaker)), ...ranges.filter((item) => !item.speaker)].flatMap(
              (item): UnclearPassage[] => {
                  const nobody = !item.speaker && item.status === "suggested" && !asked.has(item.id);

                  if (!nobody && !unaskedLow(item)) {
                      return [];
                  }

                  return [
                      {
                          fromSec: item.fromSec,
                          toSec: item.toSec,
                          speaker: item.label,
                          ...rangeAddress(item),
                          ...(opts.guesses && item.speaker
                              ? { guess: { name: item.speaker, confidence: item.confidence } }
                              : {}),
                          readings: item.speaker
                              ? withConfidence([item.speaker], item.confidence)
                              : (item.candidates ?? []),
                      },
                  ];
              }
          )
        : [];

    // Questions first: a word is marked once, and a question's choices say more than a low term's own guess.
    return [
        ...open.flatMap((question): UnclearPassage[] => {
            // A repeated word is often right as heard: a mark on each of them made the transcript unreadable (R2-MC1).
            if (question.group === "words") {
                return [];
            }

            const decided = record.items.filter((item) => question.decides.includes(item.id));

            // A speaker question's heard words only place its playback: what it doubts is the speaker, not the words.
            if (question.heard && question.about !== "speaker") {
                if (decided.some(applied)) {
                    return [];
                }

                const { fromSec, toSec, heard, choices } = question;
                return [{ fromSec, toSec, heard, readings: withConfidence(choices, question.confidence) }];
            }

            if (question.about !== "speaker") {
                return [];
            }

            return decided.flatMap((item) =>
                item.kind === "speaker-range" && item.status === "suggested" && !applied(item)
                    ? [
                          {
                              fromSec: item.fromSec,
                              toSec: item.toSec,
                              speaker: item.label,
                              ...rangeAddress(item),
                              readings: question.choices,
                              ...(opts.guesses && item.speaker
                                  ? {
                                        guess: {
                                            name: item.speaker,
                                            confidence:
                                                item.confidence !== undefined && item.confidence < opts.below
                                                    ? item.confidence
                                                    : undefined,
                                        },
                                    }
                                  : {}),
                          },
                      ]
                    : []
            );
        }),
        ...unaskedTerms,
        ...unaskedRanges,
    ];
}

/** The first reading is the rules' guess: it carries their confidence. The others have none of their own. */
function withConfidence(readings: string[], confidence: number | undefined): string[] {
    return readings.map((reading, index) =>
        index === 0 && confidence !== undefined ? `${reading} ${Math.round(confidence * 100)} %` : reading
    );
}

/** The items an open speaker question decides: their lines wait for the answer, whatever their confidence. */
export function questionOwnedItems(record: MeetingRecord): Set<string> {
    return new Set(
        openQuestions(record)
            .filter((question) => question.about === "speaker")
            .flatMap((question) => question.decides)
    );
}

/** The line address an item carries: its index in the source transcript, stored by suggest and `items add`. */
export function lineOf(item: MeetingItem): number | undefined {
    const line = item.evidence?.transcriptLine;
    return typeof line === "number" && Number.isInteger(line) && line >= 0 ? line : undefined;
}

/** The one line a speaker range names, as `look` reads it: only a range inside one second carries its line's index. */
function rangeAddress(item: MeetingItem): { line?: number } {
    const line = item.kind === "speaker-range" && item.fromSec === item.toSec ? lineOf(item) : undefined;
    return line === undefined ? {} : { line };
}

/**
 * A warning per speaker range whose `line` narrows nothing: on a range wider than one second the line stays its first
 * line's address (suggest stores a stretch that way), and the range gives a voice to every line of its label in it.
 */
export function rangeLineWarnings(items: readonly MeetingItem[]): string[] {
    return items.flatMap((item) => {
        const line = item.kind === "speaker-range" && item.fromSec !== item.toSec ? lineOf(item) : undefined;
        if (item.kind !== "speaker-range" || line === undefined) {
            return [];
        }

        return [
            `${item.id}: "line": ${line} names one line only when "from" and "to" are the same second; this range applies to every "${item.label}" line from ${formatClock(item.fromSec)} to ${formatClock(item.toSec)}. To name one line, give "from" and "to" its second`,
        ];
    });
}

/**
 * What a transcript applies: renames, then the confirmed items, then the dictionary. With `withSuggested` a suggested
 * item is applied too when its confidence reaches `global.suggest.applyAbove` (one with no confidence, a person's
 * own, always); a lower one is marked unclear, as an open question is. A speaker range built on the user's answer or
 * stated by an agent takes part at any confidence, so the order of ranges (`compareRanges`) decides its line; when an
 * agent's range under the threshold wins, the line shows it as a guess (`[Name: 60 %]`, `showsAsGuess`).
 */
export function correctionsOf(
    record: MeetingRecord,
    config: MeetingsConfig,
    opts: {
        withSuggested?: boolean;
        dictionary?: boolean;
        format: TranscriptFormat;
        include?: string[];
        applyAbove?: number;
    }
): TranscriptCorrections {
    const applyAbove = opts.applyAbove ?? config.global.suggest.applyAbove;
    if (!Number.isFinite(applyAbove) || applyAbove < 0 || applyAbove > 1) {
        throw new RangeError("applyAbove must be between 0 and 1");
    }
    const termApplyAbove = opts.applyAbove ?? config.global.suggest.terms.applyAbove;
    const questionOwned = questionOwnedItems(record);
    const unclearLabel = languageSettings(config).render.unclearLabel;
    const applies = (item: MeetingItem) =>
        item.status === "confirmed" ||
        (opts.include?.includes(item.id) === true && item.status !== "rejected" && !needsSpeakerReview(item)) ||
        (opts.withSuggested === true &&
            item.status === "suggested" &&
            !needsSpeakerReview(item) &&
            !(item.kind === "speaker-range" && questionOwned.has(item.id)) &&
            (item.confidence === undefined ||
                item.confidence >= (item.kind === "term" ? termApplyAbove : applyAbove) ||
                (item.kind === "speaker-range" && namesAtAnyConfidence(item))));
    const used = record.items
        .filter(applies)
        .sort((a, b) => Number(a.status === "confirmed") - Number(b.status === "confirmed"));
    // A label that tracks no one person marks its lines unclear, last: a question or a range's own guess says more.
    const unlabeled = used.flatMap((item): UnclearPassage[] =>
        item.kind === "label" ? [{ fromSec: item.fromSec, toSec: item.toSec, speaker: item.label, readings: [] }] : []
    );
    const passages = [
        ...(opts.withSuggested
            ? unclearPassages(record, {
                  below: applyAbove,
                  termBelow: termApplyAbove,
                  applied: applies,
                  guesses: true,
                  unclearLabel,
              })
            : unclearPassages(record, { below: config.global.suggest.listenBelow, unclearLabel })),
        ...unlabeled,
    ];

    const address = (item: MeetingItem) => {
        const line = lineOf(item);
        return line === undefined ? {} : { line };
    };
    // A person's own assignments (`assign`) come after the items' ranges, so they win over a rule's or an answer's;
    // among them the latest act wins (`at`), since a stretch given again keeps its place and id in the list. The items'
    // ranges go weakest first (`compareRanges`): a confirmed range wins over one built on the user's answer, that over
    // an agent's, and that over a rule's, whatever their age; within one kind the higher confidence wins, the latest on
    // a tie.
    const assignments = [...(record.speakers.assignments ?? [])].sort((a, b) => a.at.localeCompare(b.at));
    // A range listed by `include` is applied as asked, so only a suggestion the threshold would hold back is a guess.
    const guessOf = (item: MeetingItem) =>
        item.status === "suggested" &&
        item.confidence !== undefined &&
        opts.include?.includes(item.id) !== true &&
        showsAsGuess(item, applyAbove)
            ? { guess: item.confidence }
            : {};
    const itemRanges = weakestFirst(used).flatMap((item) =>
        item.kind === "speaker-range" && item.speaker
            ? [
                  {
                      label: item.label,
                      fromSec: item.fromSec,
                      toSec: item.toSec,
                      speaker: item.speaker,
                      item: item.id,
                      ...rangeAddress(item),
                      ...guessOf(item),
                  },
              ]
            : []
    );
    const assignmentRanges = assignments.map((assignment) => ({
        label: assignment.label,
        fromSec: assignment.fromSec - LINE_AT_TOLERANCE_SEC,
        toSec: assignment.toSec + LINE_AT_TOLERANCE_SEC,
        speaker: assignment.person,
        overrideJoin: true,
    }));
    const ranges = [...itemRanges, ...assignmentRanges];
    // A joined word makes the two lines one voice: the line before the cut takes the voice a range gives the line
    // after it, because joins apply before ranges and that range would no longer reach it. An assignment's bounds
    // already carry the line tolerance, so only an item's range is widened, once, here.
    const voiceRanges = [
        ...itemRanges.map((range) => ({
            ...range,
            fromSec: range.fromSec - LINE_AT_TOLERANCE_SEC,
            toSec: range.toSec + LINE_AT_TOLERANCE_SEC,
        })),
        ...assignmentRanges,
    ];
    const voiceAt = (label: string, atSec: number, line: number | undefined) =>
        voiceRanges.findLast(
            (range) =>
                range.label === label &&
                range.fromSec <= atSec &&
                atSec <= range.toSec &&
                (!("line" in range) || range.line === undefined || line === undefined || range.line === line)
        )?.speaker;

    return {
        labels: record.speakers.labels,
        // The removal's own line address, so two identical lines at one second are told apart, never both refused.
        removals: used.flatMap((item) =>
            item.kind === "removal"
                ? [{ item: item.id, fromSec: item.fromSec, toSec: item.toSec, heard: item.heard, ...address(item) }]
                : []
        ),
        ranges,
        joins: used.flatMap((item) =>
            item.kind === "join"
                ? [
                      {
                          atSec: item.atSec,
                          ...address(item),
                          item: item.id,
                          ...(item.speaker
                              ? { speaker: voiceAt(item.speaker, item.atSec, lineOf(item)) ?? item.speaker }
                              : {}),
                          ...(item.joined ? { joined: item.joined } : {}),
                      },
                  ]
                : []
        ),
        terms: used.flatMap((item) =>
            item.kind === "term" && item.proposed && !item.meaning && !item.quote
                ? [
                      {
                          heard: item.heard,
                          replacement: item.proposed,
                          heardStem: item.heardStem,
                          proposedStem: item.proposedStem,
                          item: item.id,
                          ...(item.reach?.lines
                              ? { lines: item.reach.lines }
                              : item.scope === "line" && item.atSec !== undefined
                                ? { atSec: item.atSec, ...address(item) }
                                : {}),
                      },
                  ]
                : []
        ),
        marks: used.flatMap((item) =>
            item.kind === "term" && item.atSec !== undefined && (item.meaning || item.quote)
                ? [
                      {
                          atSec: item.atSec,
                          ...address(item),
                          heard: item.heard,
                          item: item.id,
                          ...(item.meaning ? { meaning: item.meaning } : {}),
                          ...(item.quote ? { quote: item.quote } : {}),
                      },
                  ]
                : []
        ),
        ...(opts.dictionary === false
            ? {}
            : { dictionary: resolveDictionary(config, { project: record.project, meeting: record.dictionary }) }),
        notes: opts.format === "md" ? "sup" : "inline",
        ...(passages.length > 0 ? { unclear: { label: languageSettings(config).render.unclearLabel, passages } } : {}),
    };
}

/** What the transcript of a meeting is after its corrections, and what became of each item it applied. */
export interface CorrectedTranscript extends Omit<CorrectionsApplied, "named" | "guessed" | "sources"> {
    /** The people the lines are attributed to after the corrections, with their line counts, most lines first. */
    speakers: Array<{ name: string; lines: number }>;
    /**
     * The people an open speaker question's range guesses (`[Name: 60 %]` with `withSuggested`), with the count of
     * lines shown as that guess. A guess is not a named person: a person can be in both lists.
     */
    guesses: Array<{ name: string; lines: number }>;
    /**
     * Source labels no correction named a person for (`Speaker 5`), with the count of lines that keep them. A name can
     * be in both lists: a correction named some lines of its label, and the source labelled the rest.
     */
    unattributed: Array<{ name: string; lines: number }>;
}

/**
 * The corrections pipeline: the record's decided items (with `withSuggested`, the suggested ones at or above
 * `global.suggest.applyAbove`; with `include`, these items whatever their confidence), the dictionary, and the open
 * questions, applied to the source transcript in their fixed order. Returns the corrected lines and one outcome per
 * item: applied to its lines, not found, ambiguous (two lines in one second), or shadowed by another item.
 */
export function correctTranscript(options: {
    record: MeetingRecord;
    transcript: TranscriptEntry[];
    config: MeetingsConfig;
    format: TranscriptFormat;
    withSuggested?: boolean;
    applyAbove?: number;
    dictionary?: boolean;
    include?: string[];
}): CorrectedTranscript {
    const { record, transcript, config } = options;
    const corrections = correctionsOf(record, config, options);
    const { named, guessed, sources, ...corrected } = applyCorrections(transcript, corrections);
    // A record written before the CLI composed its arguments keeps decomposed names from the window's answers: one
    // person under two keys (src/meetings/index.ts). Every speaker is counted and rendered composed.
    // The speaker ranges are built once: rescanning the items for every entry made each corrected read quadratic in its
    // lines. A range inside one second names only the line at its address, as `look` reads it (`lineSpeakerFacts`).
    const speakerRanges = record.items.flatMap((item) =>
        item.kind === "speaker-range" ? [{ ...item, ...rangeAddress(item) }] : []
    );
    // A line is read by its own source index (`applyCorrections` keeps it), never by its second: two lines that start
    // in one second each keep their own label and their own range.
    const covers = (
        item: { fromSec: number; toSec: number; label: string; line?: number },
        { atSec, sourceIndex }: { atSec: number | undefined; sourceIndex: number | undefined }
    ) =>
        atSec !== undefined &&
        sourceIndex !== undefined &&
        atSec >= item.fromSec &&
        atSec <= item.toSec &&
        transcript[sourceIndex].speaker === item.label &&
        (item.line === undefined || item.line === sourceIndex);
    // Only a question still open about a voice leaves a line's speaker uncertain; an answered one or a term question
    // does not.
    const speakerQuestions = openQuestions(record).filter((question) => question.about === "speaker");
    const unclearLabel = languageSettings(config).render.unclearLabel;
    // The corrected lines whose speaker a correction or an answer gave, whatever the name.
    const attributed = new Set<TranscriptEntry>();
    // The corrected lines shown as a guess, with the person guessed.
    const guessedAs = new Map<TranscriptEntry, string>();
    const applied = {
        ...corrected,
        entries: corrected.entries.flatMap((rawEntry): TranscriptEntry[] => {
            const sourceIndex = sources.get(rawEntry);
            const entry =
                sourceIndex !== undefined && record.evidence?.voice?.lines[String(sourceIndex)]
                    ? { ...rawEntry, sourceIndex }
                    : rawEntry;
            const atSec = entry.startSec;
            const finding = speakerRanges.findLast(
                (item) => item.status === "confirmed" && item.voices && covers(item, { atSec, sourceIndex })
            );
            if (finding?.voices) {
                // The segments count the words of the one line the answer split, the line the range starts on.
                if (finding.segments?.length && atSec === finding.fromSec) {
                    const pieces = splitEntry(entry, finding.segments);
                    for (const piece of pieces) {
                        attributed.add(piece);
                    }

                    return pieces;
                }

                const speaker = `[${unclearLabel}: ${finding.voices.join(" + ")}]`;
                const { unclear: _open, ...decided } = entry;
                return [{ ...decided, speaker, band: "open", guess: false, voices: finding.voices }];
            }
            const proposals = speakerRanges.filter(
                (item) => item.status !== "rejected" && covers(item, { atSec, sourceIndex })
            );
            const proposal = strongestRange(proposals);
            const confidence = proposal?.confidence;
            const assigned = record.speakers.assignments?.some((assignment) =>
                covers(
                    {
                        ...assignment,
                        fromSec: assignment.fromSec - LINE_AT_TOLERANCE_SEC,
                        toSec: assignment.toSec + LINE_AT_TOLERANCE_SEC,
                    },
                    { atSec, sourceIndex }
                )
            );
            const voiceName =
                (options.withSuggested || options.include?.includes(proposal?.id ?? "")) &&
                !assigned &&
                proposal?.status === "suggested" &&
                !needsSpeakerReview(proposal) &&
                proposal.speaker &&
                proposal.rules.includes(MeetingRule.VoiceEmbedding);
            const score = typeof proposal?.evidence?.score === "number" ? proposal.evidence.score : confidence;
            let band: TranscriptEntry["band"];

            if (isUnclearMarker(entry.speaker, unclearLabel)) {
                band = "open";
            } else if (proposal?.status === "confirmed") {
                band = "confirmed";
            } else if (proposal) {
                band = entry.guess ? "guess" : "applied";
            }

            const line: TranscriptEntry = {
                ...entry,
                speaker: entry.speaker.normalize("NFC"),
                ...(atSec !== undefined &&
                speakerQuestions.some((question) => atSec >= question.fromSec && atSec <= question.toSec)
                    ? { questioned: true }
                    : {}),
                ...(proposal
                    ? {
                          ...(confidence === undefined ? {} : { confidence }),
                          ...(proposal.speaker ? { suggestedSpeaker: proposal.speaker } : {}),
                          ...(voiceName
                              ? {
                                    nameSource: "voice" as const,
                                    ...(score === undefined ? {} : { nameScore: score }),
                                }
                              : {}),
                      }
                    : {}),
                ...(band ? { band, guess: band === "guess" } : {}),
            };
            if (named.has(rawEntry)) {
                attributed.add(line);
            }

            const guess = guessed.get(rawEntry);
            if (guess !== undefined) {
                guessedAs.set(line, guess.normalize("NFC"));
            }

            return [line];
        }),
    };
    const outcomes = [...applied.outcomes, ...labelOutcomes(record, transcript, applied.outcomes, corrections)];
    for (const outcome of outcomes) {
        const item = record.items.find((item) => item.id === outcome.item);
        if (outcome.status !== "not-found" || item?.kind !== "term") {
            continue;
        }
        const diagnostic = diagnoseTermAddress({ item, transcript });
        if (diagnostic?.message) {
            outcome.reason = diagnostic.message;
        }
    }
    const unclear = `[${unclearLabel}:`;
    const sourceLabels = new Set(transcript.map((entry) => entry.speaker.normalize("NFC")));
    const people = new Set(
        [
            ...record.participants.map((person) => person.name),
            ...(record.attendance?.people.map((person) => person.name) ?? []),
            ...Object.values(record.speakers.labels),
        ].map((name) => name.normalize("NFC"))
    );
    const counts = {
        speakers: new Map<string, number>(),
        guesses: new Map<string, number>(),
        unattributed: new Map<string, number>(),
    };

    // Each line is judged on its own: a name a correction gave counts for that person even when a source label reads
    // the same, and a line that keeps a label no rename, participant or attendance names counts as the source's. A
    // guess mark (`[Name: 60 %]`) counts for the person guessed, apart from the people.
    for (const entry of applied.entries) {
        if (entry.speaker.startsWith(unclear)) {
            continue;
        }

        const guess = guessedAs.get(entry);
        if (guess !== undefined) {
            counts.guesses.set(guess, (counts.guesses.get(guess) ?? 0) + 1);
            continue;
        }

        const isPerson = attributed.has(entry) || !sourceLabels.has(entry.speaker) || people.has(entry.speaker);
        const tally = isPerson ? counts.speakers : counts.unattributed;
        tally.set(entry.speaker, (tally.get(entry.speaker) ?? 0) + 1);
    }

    const ranked = (tally: Map<string, number>) =>
        [...tally.entries()]
            .map(([name, lines]) => ({ name, lines }))
            .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));

    return {
        ...applied,
        outcomes,
        speakers: ranked(counts.speakers),
        guesses: ranked(counts.guesses),
        unattributed: ranked(counts.unattributed),
    };
}

/**
 * One line a confirmed answer split between voices, cut at each segment's first word. Each piece keeps only its own
 * words and their timings (rebased on its text), starts at its first timed word, and the pieces after the first get
 * their own id, so no two rows share one identity.
 */
function splitEntry(entry: TranscriptEntry, segments: Array<{ fromWord: number; speaker: string }>): TranscriptEntry[] {
    const spans = [...entry.text.matchAll(/\S+/g)].map((match) => ({
        from: match.index,
        to: match.index + match[0].length,
    }));

    return segments.flatMap((segment, index): TranscriptEntry[] => {
        const first = spans[segment.fromWord];
        const last = spans[(segments[index + 1]?.fromWord ?? spans.length) - 1];

        if (!first || !last || last.to <= first.from) {
            return [];
        }

        const words = entry.words
            ?.filter((word) => word.range.location >= first.from && word.range.location + word.range.length <= last.to)
            .map((word) => ({ ...word, range: { ...word.range, location: word.range.location - first.from } }));
        const startSec = index === 0 ? entry.startSec : (words?.[0]?.startSec ?? entry.startSec);

        return [
            {
                ...entry,
                ...(entry.id && index > 0 ? { id: `${entry.id}#${index}` } : {}),
                ...(startSec === undefined ? {} : { startSec }),
                ...(words ? { words } : {}),
                speaker: segment.speaker,
                text: entry.text.slice(first.from, last.to),
            },
        ];
    });
}

/**
 * What became of each label item the corrections used: applied to its lines that no range or join gave a voice, shadowed
 * when those gave every one of them a voice, not found when the label has no line in the stretch.
 */
function labelOutcomes(
    record: MeetingRecord,
    transcript: TranscriptEntry[],
    outcomes: CorrectionOutcome[],
    corrections: TranscriptCorrections
): CorrectionOutcome[] {
    const lines = new TranscriptLines(transcript);
    const voiced = new Map<number, string>();

    const voiceItems = new Set(
        record.items
            .filter((item) => (item.kind === "speaker-range" || item.kind === "join") && item.speaker)
            .map((item) => item.id)
    );

    for (const outcome of outcomes) {
        if (outcome.status === "applied" && voiceItems.has(outcome.item)) {
            for (const line of outcome.lines) {
                voiced.set(line.index, outcome.item);
            }
        }
    }

    const passages = corrections.unclear?.passages ?? [];

    return record.items.flatMap((item): CorrectionOutcome[] => {
        const used =
            item.kind === "label" &&
            passages.some(
                (passage) =>
                    passage.speaker === item.label &&
                    passage.readings.length === 0 &&
                    passage.fromSec === item.fromSec &&
                    passage.toSec === item.toSec
            );

        if (item.kind !== "label" || !used) {
            return [];
        }

        const inside = transcript.flatMap((entry, index) =>
            entry.speaker === item.label &&
            entry.startSec !== undefined &&
            entry.startSec >= item.fromSec &&
            entry.startSec <= item.toSec
                ? [index]
                : []
        );

        if (inside.length === 0) {
            return [
                {
                    item: item.id,
                    status: "not-found",
                    reason: `no line of "${item.label}" from ${formatClock(item.fromSec)} to ${formatClock(item.toSec)}`,
                },
            ];
        }

        const open = inside.filter((index) => !voiced.has(index));

        if (open.length === 0) {
            const by = voiced.get(inside[0]!)!;
            return [{ item: item.id, status: "shadowed", by, reason: `${by} and other items gave every line a voice` }];
        }

        return [{ item: item.id, status: "applied", lines: open.flatMap((index) => lines.address(index) ?? []) }];
    });
}

/** `i42 did not apply: no "X" at 37:43`. Undefined for an item that applied. */
export function outcomeText(outcome: CorrectionOutcome): string | undefined {
    if (outcome.status === "applied") {
        return undefined;
    }

    const shown = outcome.status === "ambiguous" ? `${outcome.reason}; anchor it to one of them` : outcome.reason;
    return `${outcome.item} did not apply: ${shown}`;
}

/**
 * The ledger lines one decision writes for an item, from its entry before the decision (`prior`) and after it
 * (`next`): a retraction of the earlier confirmation when the decision changes it (a reject, another spelling or
 * speaker), then the new confirmation. The ledger is append-only, so without the retraction a rejected or respelled
 * confirmation kept counting as dictionary evidence.
 */
export function decisionLedger(prior: Correction | undefined, next: Correction | undefined): Correction[] {
    const same = (a: Correction, b: Correction) =>
        SafeJSON.stringify({ ...a, at: "" }) === SafeJSON.stringify({ ...b, at: "" });
    const lines: Correction[] = [];

    if (prior && !(next && same(prior, next))) {
        lines.push({ ...prior, retracted: true });
    }

    if (next) {
        lines.push(next);
    }

    return lines;
}

/**
 * The corrections-ledger entry a confirmed item writes: a term's spelling (`heard` → `fixed`) or a join's glued
 * word. Every path that confirms an item (`items confirm`, an answered question) writes it through here.
 */
export function ledgerEntryFor(record: MeetingRecord, item: MeetingItem, now: string): Correction | undefined {
    if (item.status !== "confirmed") {
        return undefined;
    }

    const base = { at: now, meeting: record.id, project: record.project, item: item.id };

    if (item.kind === "term" && item.proposed) {
        return {
            ...base,
            kind: "term",
            scope: item.reach?.lines ? "line" : (item.scope ?? "everywhere"),
            heard: item.heard,
            fixed: item.proposed,
            ...(item.reach?.dictionary !== undefined ? { learn: item.reach.dictionary } : {}),
        };
    }

    if (item.kind === "join" && item.joined) {
        const evidence = item.evidence ?? {};
        const heard = [evidence.left, evidence.right].filter((part) => typeof part === "string").join(" ");
        return { ...base, kind: "join", heard, fixed: item.joined };
    }

    return undefined;
}

/**
 * Checks where an item is anchored: a join, or a term bound to one line, needs exactly one line at its time. Returns
 * a warning per item that names no line or two lines in one second, and the address of each item anchored to one.
 */
export function checkAnchors(
    items: MeetingItem[],
    transcript: TranscriptEntry[]
): { warnings: string[]; addresses: Map<string, number> } {
    const lines = new TranscriptLines(transcript);
    const warnings: string[] = [];
    const addresses = new Map<string, number>();

    for (const item of items) {
        const bound =
            item.kind === "join" || (item.kind === "term" && item.atSec !== undefined && item.scope === "line");
        const marked = item.kind === "term" && item.atSec !== undefined && (item.meaning || item.quote);

        if ((!bound && !marked) || (item.kind !== "join" && item.kind !== "term") || item.atSec === undefined) {
            continue;
        }

        const atSec = item.atSec;
        const heard = item.kind === "term" ? item.heard : undefined;
        const anchor = { atSec, line: lineOf(item) };
        // A mark applies on the literal heard word (`marks` in correctionsOf), so only a term that is replaced
        // anchors on its stem.
        const found =
            item.kind === "join"
                ? joinLine(lines, { ...anchor, ...(item.joined ? { joined: item.joined } : {}) })
                : heardLineAt(
                      lines,
                      anchor,
                      item.heardStem && item.proposedStem && !marked
                          ? termFixPattern({
                                heard: item.heard,
                                replacement: item.proposedStem,
                                heardStem: item.heardStem,
                                proposedStem: item.proposedStem,
                            })
                          : item.heard
                  );
        const at = formatClock(atSec);

        if (found.kind === "found") {
            if (anchor.line !== undefined && anchor.line !== found.index) {
                warnings.push(
                    `${item.id}: line ${anchor.line} does not start at ${at}; anchored to line ${found.index}`
                );
            }

            addresses.set(item.id, found.index);
            continue;
        }

        if (found.kind === "none") {
            warnings.push(`${item.id}: no line ${heard ? `with "${heard}" ` : ""}starts at ${at}`);
            continue;
        }

        const which = found.indexes
            .map((index) => `line ${index} "${(transcript[index]?.text ?? "").slice(0, 40)}"`)
            .join(", ");
        warnings.push(
            `${item.id}: ${found.indexes.length} lines start at ${at} (${which}); it will not apply until its finding names one with "line": <n>`
        );
    }

    return { warnings, addresses };
}
