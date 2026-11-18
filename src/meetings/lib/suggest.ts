import { sha256Json } from "@genesiscz/utils/hash";
import { DEFAULT_APPLY_ABOVE } from "@genesiscz/utils/meetings/config";
import { type MeetingItem, type MeetingRecord, meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";

import { MeetingRule } from "@genesiscz/utils/meetings/rules";
import { activeSeatPeople, roomSeatNames, wholeMeetingRoomPeople } from "@genesiscz/utils/meetings/seats";
import type { DictionaryCandidate, MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { LineVoice } from "@genesiscz/utils/meetings/voice-features";
import { profiler } from "@genesiscz/utils/profile";
import type { ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import { type LineEvidence, lineEvidence, presentAt } from "@genesiscz/utils/transcribe/evidence";
import type { WordCheck } from "@genesiscz/utils/transcribe/languages/word-check";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import {
    PRESENCE_TOLERANCE_SEC,
    type Presence,
    type SpeakerHint,
    sameName,
    speakerStats,
} from "@genesiscz/utils/transcribe/speakers";
import type { SummaryPoint } from "@genesiscz/utils/transcribe/summary";
import { arrivalItems } from "./arrival";

import { identifiedDepartures, matchedCallVoices } from "./departure";
import { indicatorLabels } from "./indicator-facts";
import { addQualityQuestions, uncertainSharedCallRanges } from "./listen-quality";
import { type LocalSpeech, localSpeechLines } from "./local-speech";
import type { NewItem } from "./new-item";
import { personStays, rosterPresence, speechAfter } from "./person-stays";
import { selectQuestions } from "./question-select";
import {
    DEFAULT_LISTEN_BELOW,
    DEFAULT_WORD_MIN_OCCURRENCES,
    groupSpeakerQuestions,
    questionFor,
    questionKey,
    questionRank,
    refreshSpeakerQuestions,
    wordQuestions,
} from "./questions";
import {
    evidenceItems,
    inSwap,
    LineSpeakers,
    micSure,
    retireContradictedSeats,
    scoresEvidence,
} from "./speaker-evidence";
import { assessIndicator } from "./speaker-indicator";
import { speakerLabelRule } from "./speaker-labels";
import { ATTENDANCE_CONFIDENCE } from "./speaker-labels/seat";
import type { LineLabel } from "./speaker-labels/types";
import {
    anchorScores,
    type CandidateTallies,
    lineTallies,
    mergeScores,
    rosterTallies,
    ruleEvidence,
    type SamePerson,
    scoreCandidates,
    speakerScoresOf,
} from "./speaker-scores";
import {
    knownWord,
    restoreThresholdRetirements,
    settledTermItems,
    type TermThresholds,
    termItems,
} from "./suggest-terms";
import { unlabeledStretches, unlabeledView } from "./unlabeled";

export { evidenceItems } from "./speaker-evidence";
export { dictionaryKeeps, knownWord, rawTerms, settledTermItems, spokenOnPurpose, wordFamily } from "./suggest-terms";

const prof = profiler.scope("meetings-suggest");

export const SUGGEST_RULES = ["speakers", "evidence", "terms"] as const;
export type SuggestRule = (typeof SUGGEST_RULES)[number];

export function isSuggestRule(value: string): value is SuggestRule {
    return (SUGGEST_RULES as readonly string[]).includes(value);
}

/** Confidence per rule, 0 to 1. RA is attendance (evidence); a goodbye nobody answered is only an intention. */
const CONFIDENCE = {
    attendance: ATTENDANCE_CONFIDENCE,
    join: 0.9,
    answeredLeave: 0.75,
    unansweredLeave: 0.4,
    llmBonus: 0.1,
} as const;

/** Turns the speaker hints into items. A hint without a time range (several people) gives none. */
function speakerItems(options: {
    hints: SpeakerHint[];
    selfName: string | undefined;
    selfAttendee: string | undefined;
    lastSecOf: Map<string, number>;
    /** Who named each label: a platform names the person, so attendance can tell whether they are still there. */
    originOf: Map<string, string | undefined>;
    presence: Presence[] | undefined;
    samePerson?: SamePerson;
}): NewItem[] {
    const { hints, selfName, lastSecOf } = options;
    const items: NewItem[] = [];
    // The platform may name the recording user by email; the record knows their name.
    const speakerName = (attendee: string) => (attendee === options.selfAttendee && selfName ? selfName : attendee);
    const stays = options.presence?.map((stay) => (stay.self && selfName ? { ...stay, name: selfName } : stay));
    const samePerson = options.samePerson;
    const scored = (range: {
        label: string;
        speaker?: string;
        confidence: number;
        rules: string[];
        tallies: CandidateTallies;
    }) => scoresEvidence(scoreCandidates({ ...range, tallies: range.tallies.tallies, samePerson }));

    for (const hint of hints) {
        if (hint.kind === "absent-speaker") {
            for (const range of hint.ranges) {
                const present = range.present?.map(speakerName);
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
                    evidence: {
                        lines: range.lines,
                        reason: `${hint.label} was not in the call`,
                        ...(present?.length === 1 ? { reviewOnly: true, listen: true } : {}),
                        ...scored({
                            label: hint.label,
                            ...(present?.length === 1 ? { speaker: present[0] } : {}),
                            confidence: CONFIDENCE.attendance,
                            rules: [MeetingRule.Attendance],
                            tallies: rosterTallies({
                                fromSec: range.fromSec,
                                toSec: range.toSec,
                                present,
                                selfName,
                                samePerson,
                            }),
                        }),
                    },
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
                    evidence: {
                        lines: range.lines,
                        reason: `only ${hint.person} was in the call`,
                        reviewOnly: true,
                        listen: true,
                        ...scored({
                            label: hint.label,
                            speaker,
                            confidence: CONFIDENCE.attendance,
                            rules: [MeetingRule.Attendance],
                            tallies: rosterTallies({
                                fromSec: range.fromSec,
                                toSec: range.toSec,
                                present: [speaker],
                                selfName,
                                samePerson,
                            }),
                        }),
                    },
                });
            }
        } else if (hint.kind === "leave-then-continues") {
            if (selfName && sameName(hint.label, selfName)) {
                continue;
            }
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

                const confidence = Math.min(1, base + (hint.strength === "strong" ? CONFIDENCE.llmBonus : 0));
                const rules = [
                    MeetingRule.LeavePhrase,
                    MeetingRule.ContinuesAfterLeave,
                    ...(leave.confirmedBy ? [MeetingRule.FarewellAnswered] : []),
                    ...(leave.echoOf ? [MeetingRule.EchoedFarewell] : []),
                ];
                items.push({
                    kind: "speaker-range",
                    status: "suggested",
                    label: hint.label,
                    fromSec: leave.continuesAtSec,
                    toSec: until,
                    confidence,
                    rules,
                    evidence: {
                        leaveAt: leave.atSec,
                        said: leave.text,
                        // Nobody answered the goodbye: maybe only an intention, so it is kept but never asked by ear.
                        ...(answered ? {} : { intention: true }),
                        ...(leave.confirmedBy ? { answeredBy: leave.confirmedBy } : {}),
                        ...(leave.echoOf ? { notThisPerson: leave.echoOf.label } : {}),
                        ...scored({
                            label: hint.label,
                            confidence,
                            rules,
                            tallies: rosterTallies({
                                fromSec: leave.continuesAtSec,
                                toSec: until,
                                presence: stays,
                                selfName,
                                samePerson,
                            }),
                        }),
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
                evidence: {
                    label: hint.label,
                    left: hint.join.left,
                    right: hint.join.right,
                    ...(hint.join.line !== undefined ? { transcriptLine: hint.join.line } : {}),
                },
            });
        }
    }

    return items;
}

/** Two items say the same thing: the same kind on the same label, time or word. */
export function itemKey(item: NewItem | MeetingItem): string {
    if (item.kind === "removal") {
        const line = item.evidence?.transcriptLine;
        return typeof line === "number"
            ? `removal-line|${line}|${item.fromSec}|${item.heard}`
            : `removal|${item.fromSec}|${item.heard}`;
    }
    if (item.kind === "speaker-range") {
        return `range|${item.label}|${Math.round(item.fromSec)}|${Math.round(item.toSec)}|${item.speaker ?? ""}`;
    }

    if (item.kind === "join") {
        return `join|${Math.round(item.atSec)}`;
    }

    if (item.kind === "question") {
        return questionKey(item);
    }

    if (item.kind === "label") {
        return `label|${item.label}|${Math.round(item.fromSec)}|${Math.round(item.toSec)}`;
    }

    // An unknown word is one item whatever an older run proposed for it, so a rerun adds no second one.
    if (item.rules.includes(MeetingRule.UnknownWord)) {
        return `term-unknown|${item.heard.toLowerCase()}`;
    }

    const scope = item.scope ?? (item.quote || item.meaning ? "line" : "everywhere");
    const place = `|${scope}${scope === "line" ? `|${item.meaning ?? ""}|${item.atSec ?? 0}` : ""}`;
    return `term|${item.heard.toLowerCase()}|${item.proposed ?? ""}${place}`;
}

/**
 * A speaker range a rule made without typed candidate scores (an arrival, a shared microphone or call, a cluster),
 * scored from its own lines as every other speaker range is. A range with scores, or with no line, stays as it is.
 */
function lineScored(
    item: NewItem,
    options: { lines: LineEvidence[]; speakers: LineSpeakers; selfName: string | undefined; samePerson?: SamePerson }
): NewItem {
    if (item.kind !== "speaker-range" || item.evidence?.candidateScores !== undefined) {
        return item;
    }

    const own = options.lines.filter(
        (line) => line.label === item.label && line.startSec >= item.fromSec && line.startSec <= item.toSec
    );

    if (own.length === 0) {
        return item;
    }

    const selfName = options.selfName;
    const candidates = item.candidates;
    const scores = scoreCandidates({
        tallies: lineTallies({
            lines: own,
            eligibility: options.speakers.eligibility,
            selfName: selfName ?? "",
            nearby: [],
            micHolds: (line) => selfName !== undefined && micSure(line),
            samePerson: options.samePerson,
        }).tallies.filter((tally) => tally.name !== ""),
        lines: own.length,
        label: item.label,
        speaker: item.speaker,
        confidence: item.confidence ?? 0,
        rules: item.rules,
        samePerson: options.samePerson,
    }).filter((score) => !candidates || candidates.some((name) => sameName(name, score.speaker)));
    return scores.length > 0 ? { ...item, evidence: { ...item.evidence, candidateScores: scores } } : item;
}

/** Split coarse rules before reconciling or asking about a line whose eligible people changed. */
function eligibleRanges(item: NewItem, speakers: LineSpeakers): NewItem[] {
    if (item.kind !== "speaker-range") {
        return [item];
    }
    const lines = speakers.linesFor(item);
    if (!lines.length) {
        return [item];
    }
    const parts: LineEvidence[][] = [];
    for (const line of lines) {
        const prev = parts.at(-1);
        if (prev && speakers.key(prev[0]!.index) === speakers.key(line.index)) {
            prev.push(line);
        } else {
            parts.push([line]);
        }
    }
    return parts.flatMap((part): NewItem[] => {
        const first = part[0]!;
        const last = part.at(-1)!;
        const eligible = speakers.eligibility.get(first.index)!;
        const allows = (name: string) => eligible.choices.some((other) => sameName(name, other));
        const candidates = item.candidates?.filter(allows);
        const scores = speakerScoresOf(item);
        const evidence = {
            ...item.evidence,
            ...(scores.length ? { candidateScores: scores.filter((score) => allows(score.speaker)) } : {}),
            ...(parts.length > 1 ? { endSec: last.endSec } : {}),
        };
        const range = {
            ...item,
            ...(Object.keys(evidence).length ? { evidence } : {}),
            ...(parts.length > 1 ? { fromSec: first.startSec, toSec: last.startSec } : {}),
            ...(candidates ? { candidates } : {}),
        };
        if (item.speaker && !allows(item.speaker)) {
            return [];
        }
        if (
            !item.speaker &&
            candidates?.length === 1 &&
            (item.candidates?.length ?? 0) > 1 &&
            item.rules.includes(MeetingRule.Attendance)
        ) {
            return [
                {
                    ...range,
                    speaker: candidates[0],
                    evidence: { ...evidence, reviewOnly: true, reason: "roster-elimination", listen: true },
                },
            ];
        }
        return [range];
    });
}

/** Two independent rules agreeing never reach certainty: a person still confirms. */
const AGREEING_MAX = 0.95;

/** One item from two rules that found the same thing: both rules, and 1 - (1 - a)(1 - b) as the confidence. */
function agreeing(first: NewItem, second: NewItem): NewItem {
    const a = first.confidence;
    const b = second.confidence;
    // The channel and the seat use the same audio. Agreement cannot remove a calibrated seat's confidence limit.
    const seatLimit = (item: NewItem) =>
        item.evidence?.reason === "seat-of-one" && typeof item.evidence.score === "number"
            ? item.evidence.score
            : AGREEING_MAX;
    const confidence =
        a === undefined || b === undefined
            ? (a ?? b)
            : Math.min(
                  AGREEING_MAX,
                  seatLimit(first),
                  seatLimit(second),
                  Math.round((1 - (1 - a) * (1 - b)) * 100) / 100
              );
    const evidence = { ...second.evidence, ...first.evidence };
    const review = [first, second].find((item) => item.evidence?.reviewOnly === true);
    if (review) {
        const matched = [first, second].some(
            (item) =>
                item.rules.includes(MeetingRule.Voice) ||
                item.evidence?.reason === "named" ||
                !!item.evidence?.voiceSupport ||
                item.evidence?.decisionGate === "cosine and margin"
        );
        evidence.reviewOnly = !matched;
        if (!matched) {
            evidence.reason = review.evidence?.reason;
            evidence.listen = true;
        }
    }
    // Both rules' alternatives stay: one rule may score only its speaker while the other scored E3's or E4's people.
    const scores =
        first.kind === "speaker-range"
            ? mergeScores(speakerScoresOf(first), speakerScoresOf({ kind: second.kind, evidence: second.evidence }))
            : [];
    const candidateScores =
        first.kind === "speaker-range" && first.speaker && confidence !== undefined
            ? anchorScores(scores, first.speaker, confidence, ruleEvidence(second.rules))
            : scores;
    return {
        ...first,
        rules: [...new Set([...first.rules, ...second.rules])],
        ...(confidence === undefined ? {} : { confidence }),
        evidence: scores.length > 0 ? { ...evidence, candidateScores } : evidence,
    };
}

/** Reconcile line proposals here, where the old rules already meet; labelers never create or save items. */
function labeledItems(options: {
    labels: LineLabel[];
    found: NewItem[];
    record: MeetingRecord;
    meeting: SourceMeeting;
}): NewItem[] {
    const { record, meeting } = options;
    const spans = new TranscriptLines(meeting.transcript);
    const proposed = new Map<number, NewItem>();
    const strangers = new Map<number, { owner: string; stretch: number }>();
    const covers = (item: NewItem, label: string, at: number) =>
        item.kind === "speaker-range" && item.label === label && item.fromSec <= at && item.toSec >= at;
    // Indexed once by transcript label, so each proposed line reads only the ranges of its own label.
    const byLabel = <T extends { label: string }>(items: readonly T[]) => {
        const index = new Map<string, T[]>();
        for (const item of items) {
            const list = index.get(item.label) ?? [];
            list.push(item);
            index.set(item.label, list);
        }
        return index;
    };
    const ranges = (items: readonly NewItem[]) => byLabel(items.filter((item) => item.kind === "speaker-range"));
    const confirmed = ranges(record.items.filter((item) => item.status === "confirmed"));
    const assignments = byLabel(record.speakers.assignments ?? []);
    const suggested = ranges([...options.found, ...record.items.filter((one) => one.status === "suggested")]);
    // The lines a range covers: a binary search over the lines by start, then its own label.
    const coveredLines = (item: Extract<NewItem, { kind: "speaker-range" }>) =>
        spans.startingBetween(item.fromSec, item.toSec).filter(({ entry }) => entry.speaker === item.label);

    for (const label of [...options.labels].sort((a, b) => a.index - b.index)) {
        const entry = meeting.transcript[label.index];
        const at = entry?.startSec;

        if (!entry || at === undefined) {
            continue;
        }

        if (
            confirmed.get(entry.speaker)?.some((item) => covers(item, entry.speaker, at)) ||
            assignments.get(entry.speaker)?.some((item) => item.fromSec <= at && item.toSec >= at)
        ) {
            continue;
        }

        const matched = options.found.find(
            (one) =>
                covers(one, entry.speaker, at) &&
                one.kind === "speaker-range" &&
                one.speaker &&
                (one.rules.includes(MeetingRule.Voice) || one.evidence?.decisionGate === "cosine and margin")
        );
        if (
            matched?.kind === "speaker-range" &&
            (label.reason !== "named" || !label.person || !sameName(label.person, matched.speaker!))
        ) {
            proposed.set(label.index, {
                ...matched,
                fromSec: at,
                toSec: at,
                evidence: { ...matched.evidence, transcriptLine: label.index, endSec: spans.end(label.index) },
            });
            continue;
        }

        if (label.reason === "not-the-seat-person") {
            const active = record.seats && activeSeatPeople({ seats: record.seats, atSec: at });
            const owner =
                label.next?.person ??
                (label.seat === "mic"
                    ? (active?.room[0] ?? record.participants.find((person) => person.self)?.name)
                    : active?.remote[0]?.name);
            if (!owner) {
                continue;
            }
            const previous = strangers.get(label.index - 1);
            const stretch = previous?.owner === owner ? previous.stretch : label.index;
            strangers.set(label.index, { owner, stretch });
            proposed.set(label.index, {
                kind: "speaker-range",
                status: "suggested",
                label: entry.speaker,
                fromSec: at,
                toSec: at,
                confidence: label.score === undefined ? undefined : Math.max(0, label.score),
                rules: [MeetingRule.VoiceEmbedding],
                evidence: {
                    reason: label.reason,
                    seat: label.seat,
                    score: label.score,
                    seatPerson: owner,
                    strangerStretch: stretch,
                    transcriptLine: label.index,
                    endSec: spans.end(label.index),
                    listen: true,
                },
            });
            continue;
        }

        if (!label.person) {
            continue;
        }

        const previous = proposed.get(label.index - 1);
        const continuesExclusion =
            previous?.kind === "speaker-range" &&
            previous.label === entry.speaker &&
            previous.evidence?.exclusionPerson === label.person &&
            previous.evidence?.seat === label.seat &&
            previous.evidence?.endSec === at &&
            typeof previous.evidence?.exclusionStretch === "number";
        let item: NewItem = {
            kind: "speaker-range",
            status: "suggested",
            label: entry.speaker,
            fromSec: at,
            toSec: at,
            speaker: label.person,
            confidence: label.score ?? CONFIDENCE.attendance,
            rules: [speakerLabelRule(label.labeler)],
            evidence: {
                labeler: label.labeler,
                reason: label.reason,
                seat: label.seat,
                transcriptLine: label.index,
                endSec: spans.end(label.index),
                ...(label.score === undefined ? {} : { score: label.score }),
                ...(label.next ? { next: label.next } : {}),
                ...(label.voiceSupport ? { voiceSupport: label.voiceSupport } : {}),
                ...(label.reviewOnly && !label.voiceSupport ? { reviewOnly: true, listen: true } : {}),
                ...(label.reason === "exclusion"
                    ? {
                          reviewOnly: true,
                          margin: label.margin,
                          listen: true,
                          exclusionPerson: label.person,
                          exclusionStretch: continuesExclusion ? previous.evidence?.exclusionStretch : label.index,
                      }
                    : {}),
            },
        };
        const stored = record.items.filter(
            (one) =>
                covers(one, entry.speaker, at) &&
                (one.status === "suggested" ||
                    (one.status === "rejected" &&
                        one.evidence?.retired === "calibrated-seat" &&
                        !one.decision &&
                        !one.decidedAt &&
                        label.reason === "seat-of-one" &&
                        one.evidence.transcriptLine === label.index &&
                        one.kind === "speaker-range" &&
                        one.speaker &&
                        sameName(one.speaker, label.person!)))
        );
        const older = [...options.found.filter((one) => covers(one, entry.speaker, at)), ...stored];

        // A rerun keeps this line's item ID. Its confidence and voice support follow the current seat proposal.
        if (label.reason === "seat-of-one") {
            for (const old of stored) {
                if (
                    old.kind === "speaker-range" &&
                    old.evidence?.labeler === "seat" &&
                    old.evidence.transcriptLine === label.index &&
                    old.speaker &&
                    sameName(old.speaker, label.person)
                ) {
                    const { voiceSupport: _previous, score: _score, retired: _retired, ...rest } = old.evidence;
                    old.status = "suggested";
                    const confidence = label.score ?? CONFIDENCE.attendance;
                    const scores =
                        old.confidence !== confidence && old.evidence.candidateScores
                            ? anchorScores(speakerScoresOf(old), old.speaker, confidence)
                            : undefined;
                    old.confidence = confidence;
                    old.evidence = {
                        ...rest,
                        ...(scores ? { candidateScores: scores } : {}),
                        ...(label.score !== undefined ? { score: label.score } : {}),
                        ...(label.voiceSupport ? { voiceSupport: label.voiceSupport } : {}),
                    };
                }
            }
        }
        const rivals: string[] = [];

        for (const old of older) {
            if (old.kind !== "speaker-range") {
                continue;
            }

            if (old.speaker && !sameName(old.speaker, label.person)) {
                if (
                    label.reason !== "named" ||
                    old.rules.includes(MeetingRule.Voice) ||
                    old.evidence?.reason === "named"
                ) {
                    rivals.push(old.speaker);
                }
            } else if (old.speaker && label.reason !== "exclusion") {
                item = agreeing(item, old);
            }
        }

        if (rivals.length > 0 && item.kind === "speaker-range") {
            item = {
                ...item,
                speaker: undefined,
                candidates: [label.person, ...rivals].filter(
                    (person, index, names) => names.findIndex((other) => sameName(person, other)) === index
                ),
                rules: [...new Set([...item.rules, ...older.flatMap((old) => old.rules)])],
                evidence: { ...item.evidence, labelConflict: true, listen: true },
            };
        }

        proposed.set(label.index, item);
    }

    const independent = [...proposed].filter(
        ([, item]) =>
            item.kind === "speaker-range" &&
            item.speaker &&
            (item.evidence?.reason === "named" ||
                item.rules.includes(MeetingRule.Voice) ||
                item.evidence?.decisionGate === "cosine and margin")
    );
    const replaced = record.items.filter(
        (item) =>
            item.kind === "speaker-range" &&
            item.status === "suggested" &&
            item.evidence?.reason !== "not-the-seat-person" &&
            !item.decision &&
            !item.rules.includes(MeetingRule.User) &&
            !item.rules.includes(MeetingRule.Agent) &&
            ([...strangers.keys()].some((index) => {
                const entry = meeting.transcript[index];
                return entry.startSec !== undefined && covers(item, entry.speaker, entry.startSec);
            }) ||
                independent.some(([index, winner]) => {
                    const entry = meeting.transcript[index]!;
                    return (
                        winner.kind === "speaker-range" &&
                        !!winner.speaker &&
                        !!item.speaker &&
                        !sameName(winner.speaker, item.speaker) &&
                        entry.startSec !== undefined &&
                        covers(item, entry.speaker, entry.startSec)
                    );
                }))
    );
    const previous = replaced.map((item) => ({ ...item, evidence: { ...item.evidence } }));
    for (const item of replaced) {
        item.status = "rejected";
        item.evidence = {
            ...item.evidence,
            retired: [...strangers.keys()].some((i) => {
                const line = meeting.transcript[i]!;
                return line.startSec !== undefined && covers(item, line.speaker, line.startSec);
            })
                ? "not-the-seat-person"
                : "independent-voice",
        };
    }
    const retained = [...options.found, ...previous].flatMap((item): NewItem[] => {
        if (item.kind !== "speaker-range") {
            return [item];
        }

        const lines = coveredLines(item).map(({ entry, index }) => ({ index, at: entry.startSec! }));

        if (!lines.some((line) => proposed.has(line.index))) {
            return [item];
        }

        // Only the covered lines are replaced. The rest of a coarse old range keeps its rule and person.
        return lines
            .filter((line) => !proposed.has(line.index))
            .map((line) => ({
                ...item,
                fromSec: line.at,
                toSec: line.at,
                evidence: { ...item.evidence, transcriptLine: line.index },
            }));
    });
    return [...retained, ...proposed.values()];
}

/**
 * New suggestions for a meeting from its source transcript. An item the record already holds (in any status) is not
 * suggested again, so a rejected one stays rejected.
 */
export interface SuggestInputs {
    localSpeech?: LocalSpeech[];
    record: MeetingRecord;
    meeting: SourceMeeting;
    rules: SuggestRule[];
    dictionary: ResolvedDictionary;
    sourceWords: DictionaryCandidate[];
    presence?: Presence[];
    evidence?: MeetingEvidence | null;
    /** Measurements shared with the sampled questions of the same run, on the source labels. */
    measuredLines?: LineEvidence[];
    /** The microphone channel's share of the audio energy over a time range (R2.1), when the audio is at hand. */
    energyMicShare?: (fromSec: number, toSec: number) => number | undefined;
    voice?: LineVoice[];
    labels?: LineLabel[];
    applyAbove?: number;
    /** In a stored suggestion run, update roster stays with the voice evidence from this same pass. */
    leaveSilenceMinutes?: number;
    /** Items under this confidence become questions to answer by ear, when they matter (default 0.6). */
    listenBelow?: number;
    /** The summary's action items and decisions: a range that cites one matters more. */
    points?: SummaryPoint[];
    /** At most this many questions, speakers and terms together (`global.suggest.questionCap`). */
    questionBudget?: number;
    /** A word form heard this often is a question of the group `words`, outside the budget (`global.suggest.words`). */
    wordQuestions?: { minOccurrences: number };
    /** No question under this priority (`playback.listen.minPriority`). */
    minPriority?: number;
    termThresholds?: TermThresholds;
    /** Tells ordinary words from unknown ones for the term rules; without it they skip every Czech word. */
    wordCheck?: WordCheck;
    /** How a quote names its source (`languages.<global.language>.render`). */
    sourceLabels?: { readAloudLabel: string; lineLabel: string };
    /** `global.suggest.restatedIdentifiers` (default `skip`). */
    restatedIdentifiers?: "skip" | "mark";
    /** One person under two names (the people directory): a speaker range scores them as one candidate. */
    samePerson?: SamePerson;
    now: string;
    quality?: { longStretchWords: number; features?: LineVoice[] };
    retireTerms?: boolean;
}

function buildSuggestions(options: SuggestInputs): void {
    const { record } = options;
    // A label item says the label tracks no one person in its stretch: the speaker rules see those lines unlabeled.
    const indicated: NewItem[] = options.rules.some((rule) => rule === "speakers" || rule === "evidence")
        ? indicatorLabels({
              meeting: options.meeting,
              evidence: options.evidence ?? null,
              presence: options.presence,
          }).flatMap((label): NewItem[] =>
              label.fromSec === undefined || label.toSec === undefined
                  ? []
                  : [
                        {
                            kind: "label",
                            label: label.label,
                            fromSec: label.fromSec,
                            toSec: label.toSec,
                            meaningless: true,
                            status: "suggested",
                            confidence: 0.8,
                            rules: [MeetingRule.PlatformPrehistory],
                            evidence: {
                                reason: "platform label speaks before its first own indicator or join",
                                ...label,
                            },
                        },
                    ]
          )
        : [];
    // A stretch a person rejected (or any decision already made on it) is never manufactured again for this run.
    const decidedKeys = new Set(record.items.map(itemKey));
    const prehistory = indicated.filter((item) => !decidedKeys.has(itemKey(item)));
    const unlabeled = unlabeledView(
        options.meeting,
        unlabeledStretches([
            ...record.items,
            ...prehistory.map((item, index) =>
                meetingItemSchema.parse({
                    ...item,
                    id: `i${record.items.length + index + 1000000}`,
                    suggestedAt: options.now,
                })
            ),
        ])
    );
    const meeting = unlabeled.meeting;
    const found: NewItem[] = [...prehistory];

    if (options.localSpeech?.length) {
        using _local = prof.section("evidence.local-speech");
        found.push(
            ...localSpeechLines({
                transcript: meeting.transcript,
                start: meeting.start,
                calls: options.localSpeech,
            }).map(
                (line): NewItem => ({
                    kind: "removal",
                    fromSec: line.fromSec,
                    toSec: line.fromSec,
                    heard: line.text,
                    status: "suggested",
                    confidence: 0.9,
                    rules: [MeetingRule.LocalSpeech],
                    evidence: { reason: "local speech output", transcriptLine: line.index },
                })
            )
        );
    }

    const selfNameForDeparture = record.participants.find((person) => person.self)?.name ?? options.evidence?.selfName;
    const evidence = options.evidence;
    const sourceLines =
        options.measuredLines ??
        prof.measure("rules.line-evidence", () =>
            lineEvidence(
                options.meeting.transcript,
                evidence ?? { segments: [], speaking: [] },
                options.presence,
                options.energyMicShare
            )
        );

    const departureLines =
        meeting === options.meeting
            ? sourceLines
            : sourceLines.map((line) => ({
                  ...line,
                  label: meeting.transcript[line.index]!.speaker,
              }));
    const needsSpeakers = options.rules.includes("speakers");
    const originalPresence = options.presence;
    const initialStats =
        needsSpeakers || (selfNameForDeparture && departureLines.length)
            ? prof.measure("rules.speaker-stats", () =>
                  speakerStats(meeting.transcript, {
                      participants: meeting.speakers,
                      presence: options.presence,
                  })
              )
            : undefined;
    const durationSec = departureLines.reduce((end, line) => Math.max(end, line.endSec), 0);
    const deriveStays = options.leaveSilenceMinutes !== undefined && selfNameForDeparture && durationSec > 0;
    const roster = deriveStays ? rosterPresence(record, durationSec, { rederiveLeaves: true }) : [];
    const matchedVoices = matchedCallVoices(record, departureLines, options.labels);
    const departures =
        selfNameForDeparture && initialStats && departureLines.length
            ? identifiedDepartures({
                  record,
                  hints: initialStats.hints,
                  lines: departureLines.map((line) => (line.speakingUnknown ? { ...line, speaking: {} } : line)),
                  selfName: selfNameForDeparture,
                  presence: roster.length ? roster : options.presence,
                  speaking: evidence?.speaking,
                  matchedVoices,
                  roomPeople: wholeMeetingRoomPeople(record.seats),
                  ignoredIndicator: assessIndicator({
                      lines: departureLines,
                      selfName: selfNameForDeparture,
                      roomPeople: wholeMeetingRoomPeople(record.seats),
                  }).ignored,
              }).filter(
                  (event) =>
                      !speechAfter({
                          record,
                          name: event.name,
                          after: event.atSec + 5,
                          lines: departureLines,
                          speaking: evidence?.speaking,
                          matchedVoices,
                      })
              )
            : [];
    if (deriveStays) {
        const derived = personStays({
            record,
            durationSec,
            lines: departureLines,
            departures,
            speaking: evidence?.speaking,
            matchedVoices,
            silenceMinutes: options.leaveSilenceMinutes,
            callSilent: record.evidence?.channels?.callSilent,
        });
        for (const [index, person] of record.participants.entries()) {
            const stays = derived[index]?.stays;
            if (stays?.length) {
                person.stays = stays;
            }
        }
    }
    if (options.rules.includes("speakers") || options.rules.includes("evidence")) {
        for (const departure of departures) {
            const line = departureLines.find((line) =>
                departure.lineIndex === undefined
                    ? line.startSec === departure.atSec
                    : line.index === departure.lineIndex
            );
            if (line) {
                found.push({
                    kind: "speaker-range",
                    status: "suggested",
                    label: line.label,
                    fromSec: line.startSec,
                    toSec: line.startSec,
                    speaker: departure.name,
                    confidence: departure.confidence ?? 0.75,
                    rules: [MeetingRule.LeavePhrase],
                    evidence: {
                        departure,
                        reason: `${departure.name} says goodbye here; identity from ${departure.reason}`,
                        ...(departure.reason === "sole-remote" ? { reviewOnly: true, listen: true } : {}),
                    },
                });
            }
        }
    }
    const departurePresence = options.presence ?? roster;
    if (departurePresence.length && departures.length > 0) {
        options = {
            ...options,
            presence: departurePresence.map((stay) => {
                const departure = departures.find(
                    (event) =>
                        sameName(event.name, stay.name) && event.atSec >= stay.fromSec && event.atSec < stay.toSec
                );
                // The sign-off itself supplies the boundary. Include that utterance in the scoring snapshot.
                const farewell =
                    departure &&
                    departureLines.find(
                        (row) =>
                            row.startSec === departure.atSec &&
                            (departure.lineIndex === undefined || row.index === departure.lineIndex)
                    );
                return departure ? { ...stay, toSec: Math.min(stay.toSec, farewell?.endSec ?? departure.atSec) } : stay;
            }),
        };
    }
    const speakers = new LineSpeakers({
        lines: sourceLines,
        record,
        meeting: options.meeting,
        selfName: selfNameForDeparture,
        presence: options.presence,
        people: options.labels?.flatMap((row) => row.person ?? []),
    });
    if (needsSpeakers && initialStats) {
        using _speakers = prof.section("rule.speakers");
        const stats =
            options.presence === originalPresence
                ? initialStats
                : speakerStats(meeting.transcript, {
                      participants: meeting.speakers,
                      presence: options.presence,
                  });
        const lastSecOf = new Map(stats.speakers.map((stat) => [stat.label, stat.lastSec ?? 0]));
        const selfName = record.participants.find((person) => person.self)?.name;
        const safeHints = stats.hints.flatMap((hint): SpeakerHint[] => {
            if (hint.kind !== "leave-then-continues") {
                return [hint];
            }
            const leaves = hint.leaves.filter((leave) =>
                departures.some((departure) => departure.atSec === leave.atSec && departure.label === hint.label)
            );
            return leaves.length > 0 ? [{ ...hint, leaves }] : [];
        });
        const selfAttendee = options.presence?.find((stay) => stay.self)?.name;
        found.push(
            ...speakerItems({
                hints: safeHints,
                selfName,
                selfAttendee,
                lastSecOf,
                originOf: new Map(stats.speakers.map((stat) => [stat.label, stat.origin])),
                presence: options.presence,
                samePerson: options.samePerson,
            })
        );
    }

    if (options.rules.includes("evidence") && options.evidence) {
        using _evidence = prof.section("rule.evidence");
        // Departures can shorten attendance. Only the present names depend on that change.
        const presence = options.presence;
        const lines =
            presence && presence !== originalPresence
                ? departureLines.map((line) => ({ ...line, present: presentAt(presence, line.startSec) }))
                : departureLines;
        const channel = evidenceItems({
            meeting,
            evidence: options.evidence,
            lines,
            presence: options.presence,
            energyMicShare: options.energyMicShare,
            items: record.items,
            record,
            voiceMatches: record.evidence?.voice?.lines,
            speakers,
            samePerson: options.samePerson,
        });

        // A shared device's range may name the room person whose anchored voice cluster holds every line of it: the
        // one exception to candidate-only shared-device ranges. It stays a proposal at 0.7 with its candidates, to
        // listen, since a cluster's confidence measures separation, not identity. Never over conflicting channels.
        const clusterOf = new Map<number, NonNullable<LineVoice["cluster"]>>();

        for (const value of options.voice ?? []) {
            if (value.cluster && !clusterOf.has(value.index)) {
                clusterOf.set(value.index, value.cluster);
            }
        }

        if (clusterOf.size > 0) {
            const linesOf = new Map<string, Array<{ index: number; startSec: number }>>();
            meeting.transcript.forEach((entry, index) => {
                if (entry.startSec !== undefined) {
                    const group = linesOf.get(entry.speaker) ?? [];
                    group.push({ index, startSec: entry.startSec });
                    linesOf.set(entry.speaker, group);
                }
            });

            for (const item of channel.items) {
                if (
                    item.kind !== "speaker-range" ||
                    !item.candidates?.length ||
                    item.evidence?.channelConflict === true ||
                    (typeof item.evidence?.echoLines === "number" && item.evidence.echoLines > 0)
                ) {
                    continue;
                }
                const labelLines = [...linesOf].flatMap(([label, group]) => (sameName(label, item.label) ? group : []));
                const indices = labelLines.flatMap((entry) =>
                    entry.startSec >= item.fromSec && entry.startSec <= item.toSec ? [entry.index] : []
                );
                const clusters = indices.map((index) => clusterOf.get(index));
                const first = clusters[0];
                const cluster =
                    first?.speaker &&
                    clusters.every(
                        (value) => value !== undefined && value.speaker === first.speaker && value.confidence >= 0.8
                    )
                        ? first
                        : undefined;
                if (
                    cluster?.speaker &&
                    cluster.confidence >= 0.8 &&
                    item.candidates.some((name) => sameName(name, cluster.speaker!))
                ) {
                    item.speaker = cluster.speaker;
                    item.confidence = 0.7;
                    item.evidence = {
                        ...item.evidence,
                        listen: true,
                        note: "anchored voice feature cluster; confidence is a separation heuristic",
                    };
                }
            }
        }
        const arrivals = arrivalItems({
            entries: meeting.transcript,
            lines,
            presence: options.presence,
            speakingReadings: options.evidence.speaking,
        });
        // A greeting inside a swapped stretch is under a swapped label: R20 already names its speaker.
        const ruled = [
            ...channel.items,
            ...arrivals.filter((item) => !inSwap(channel.swaps, item.label, item.fromSec)),
            ...uncertainSharedCallRanges({
                record,
                lines,
                speakers,
            }),
        ];
        found.push(
            ...ruled.map((item) =>
                lineScored(item, {
                    lines: departureLines,
                    speakers,
                    selfName: selfNameForDeparture,
                    samePerson: options.samePerson,
                })
            )
        );
    }

    found.splice(0, found.length, ...found.map(unlabeled.restore));

    if (options.labels && (options.rules.includes("speakers") || options.rules.includes("evidence"))) {
        retireContradictedSeats({ record, lines: sourceLines, applyAbove: options.applyAbove });
    }

    if (options.labels?.length && (options.rules.includes("speakers") || options.rules.includes("evidence"))) {
        found.splice(
            0,
            found.length,
            ...labeledItems({
                labels: options.labels.filter((label) => {
                    const choices = speakers.eligibility.get(label.index)?.choices;
                    return !choices || !label.person || choices.some((name) => sameName(name, label.person!));
                }),
                found,
                record,
                meeting: options.meeting,
            })
        );
    }

    if (options.rules.includes("terms")) {
        using _terms = prof.section("rule.terms");
        found.push(...termItems(options));
    }

    // Two rules that reach the same item (same label, range and speaker) agree: one item with both, scored higher.
    if (options.rules.some((rule) => rule !== "terms")) {
        for (const prior of record.items) {
            if (
                prior.kind !== "speaker-range" ||
                prior.status !== "suggested" ||
                prior.decision ||
                !prior.rules.length ||
                prior.rules.includes(MeetingRule.Agent) ||
                prior.rules.includes(MeetingRule.User)
            ) {
                continue;
            }
            const parts = eligibleRanges(prior, speakers);
            if (parts.length !== 1 || itemKey(parts[0]!) !== itemKey(prior)) {
                prior.status = "rejected";
                prior.evidence = { ...prior.evidence, retired: "speaker-eligibility" };
                found.push(...parts);
            } else {
                const [part] = parts;
                if (part?.kind === "speaker-range") {
                    if (prior.candidates && !Bun.deepEquals(prior.candidates, part.candidates)) {
                        prior.candidates = part.candidates;
                    }
                    if (part.evidence && !Bun.deepEquals(prior.evidence, part.evidence)) {
                        prior.evidence = part.evidence;
                    }
                }
            }
        }
    }
    const merged = new Map<string, NewItem>();

    for (const item of found.flatMap((one) => eligibleRanges(one, speakers))) {
        const key = itemKey(item);
        const seen = merged.get(key);
        merged.set(key, seen ? agreeing(seen, item) : item);
    }

    // Old recordings can contain an automatic above-threshold attribution for the same elimination.
    // Keep its ID so open questions and the decision journal still address the same target.
    const priorByKey = new Map(record.items.map((item) => [itemKey(item), item]));
    const known = decidedKeys;
    const fresh: MeetingItem[] = [];
    const taken = [...record.items];

    for (const item of merged.values()) {
        const namedKey = itemKey(item);
        if (item.kind === "speaker-range" && item.evidence?.reviewOnly === true) {
            const apply = options.applyAbove ?? DEFAULT_APPLY_ABOVE;
            item.confidence = Math.min(item.confidence ?? 1, Math.max(0, Math.round(apply * 100) - 1) / 100);
            if (item.speaker) {
                item.candidates ??= [item.speaker];
                item.evidence.candidateScores = anchorScores(speakerScoresOf(item), item.speaker, item.confidence);
                if (apply === 0) {
                    delete item.speaker;
                }
            }
        }
        const key = itemKey(item);
        const prior =
            priorByKey.get(key) ??
            priorByKey.get(namedKey) ??
            (item.kind === "speaker-range" && item.evidence?.reviewOnly && item.speaker
                ? priorByKey.get(itemKey({ ...item, speaker: undefined }))
                : undefined);
        const retiredByEligibility =
            prior?.status === "rejected" && prior.evidence?.retired === "speaker-eligibility" && !prior.decidedAt;
        if (
            prior?.kind === "speaker-range" &&
            item.kind === "speaker-range" &&
            (prior.status === "suggested" || retiredByEligibility) &&
            prior.rules.length &&
            !prior.decision &&
            !prior.rules.includes(MeetingRule.Agent) &&
            !prior.rules.includes(MeetingRule.User) &&
            (retiredByEligibility || item.evidence?.reviewOnly === true || prior.evidence?.reviewOnly === true)
        ) {
            prior.status = "suggested";
            if (item.speaker) {
                prior.speaker = item.speaker;
            } else {
                delete prior.speaker;
            }
            if (item.candidates) {
                prior.candidates = item.candidates;
            } else {
                delete prior.candidates;
            }
            prior.confidence = item.confidence;
            prior.rules = item.rules;
            prior.evidence = item.evidence;
            continue;
        }

        // Older removals can address a passage only by its time and words.
        if (known.has(key) || (item.kind === "removal" && known.has(`removal|${item.fromSec}|${item.heard}`))) {
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
        speakers,
        presence: options.presence,
        transcript: options.meeting.transcript,
        candidates: [
            ...options.meeting.participants.map((person) => person.name),
            ...(options.evidence?.selfName ? [options.evidence.selfName] : []),
            ...record.participants.map((person) => person.name),
            ...roomSeatNames(record.seats),
            ...(record.seats?.remote.map((seat) => seat.name) ?? []),
            ...(options.evidence?.speaking.flatMap((reading) => [...reading.speaking, ...(reading.muted ?? [])]) ?? []),
            ...(record.attendance?.people.map((person) => person.name) ?? []),
            ...Object.values(record.speakers.labels),
        ],
        points: options.points ?? [],
    };
    if (options.rules.some((rule) => rule !== "terms")) {
        refreshSpeakerQuestions(record.items, context);
    }
    const askedItems = new Set(
        record.items.flatMap((item) =>
            item.kind === "question" && item.evidence?.retired !== "speaker-eligibility" ? item.decides : []
        )
    );
    const voiceQuestions = groupSpeakerQuestions(taken, askedItems, context);
    const candidates = taken
        .filter(
            (item) =>
                !askedItems.has(item.id) &&
                item.evidence?.reviewOnly !== true &&
                item.evidence?.strangerStretch === undefined &&
                item.evidence?.exclusionStretch === undefined
        )
        .flatMap((item) => {
            // A disagreement about identity needs an answer even on a short line or against the attendance list.
            const conflict = item.evidence?.labelConflict === true;
            const question = questionFor(
                item,
                conflict ? { ...context, transcript: [], presence: undefined } : context
            );
            return question
                ? [{ ...question, evidence: { ...question.evidence, ...(conflict ? { labelConflict: true } : {}) } }]
                : [];
        });

    // Keep the same evidence identity on unasked ranges, so a later answer can improve the whole compatible group.
    for (const item of taken) {
        if (
            item.kind === "speaker-range" &&
            item.status === "suggested" &&
            item.evidence?.signature &&
            speakers.linesFor(item).some((line) => speakers.unknownCall(line.index))
        ) {
            delete item.evidence.signature;
        }
    }
    const signatureQuestions = taken
        .filter(
            (item) =>
                item.evidence?.reviewOnly !== true &&
                item.evidence?.strangerStretch === undefined &&
                item.evidence?.exclusionStretch === undefined
        )
        .flatMap((item) => questionFor(item, { ...context, listenBelow: Math.max(0.7, context.listenBelow) }) ?? []);
    for (const question of signatureQuestions) {
        if (question.about !== "speaker" || !question.signature) {
            continue;
        }
        for (const target of taken) {
            if (target.kind === "speaker-range" && question.decides.includes(target.id)) {
                target.evidence = { ...target.evidence, signature: question.signature, choices: question.choices };
            }
        }
    }

    // One budget for speakers and terms together, for the meeting and not per run: a question still open counts, so a
    // second suggest asks nothing new until some are answered (MC4: a second run added 11, 23 open of a cap of 12).
    const open = record.items.filter(
        (item) => item.kind === "question" && item.status === "suggested" && (item.group ?? "rules") === "rules"
    ).length;
    const budget = Math.max(0, (options.questionBudget ?? Number.POSITIVE_INFINITY) - open);
    const wordLines = new Set<number>();
    const worth = [
        ...selectQuestions(
            candidates.filter((question) => question.evidence?.labelConflict === true),
            []
        ),
        ...selectQuestions(
            candidates.filter((question) => question.evidence?.labelConflict !== true),
            taken
        ),
    ]
        .filter((question) => (question.priority ?? 0) >= (options.minPriority ?? 0))
        .sort((a, b) => questionRank(b) - questionRank(a))
        .filter((question) => {
            // One unknown word asked per line: four words of one line are one listen, not four.
            if (question.about !== "term" || !question.rules.includes(MeetingRule.UnknownWord)) {
                return true;
            }

            const line = Math.round(question.fromSec);

            if (wordLines.has(line)) {
                return false;
            }

            wordLines.add(line);
            return true;
        });
    // An exclusion (another person's voice on a shared seat) is asked whatever the budget, even a zero one. A stranger
    // stretch's question is a speaker question of the group rules like any other: it comes first, inside the budget.
    const exclusions = voiceQuestions.filter((question) => question.evidence.reason === "exclusion");
    const strangers = voiceQuestions.filter((question) => question.evidence.reason !== "exclusion");
    let left = budget;
    const ordered = [
        ...exclusions.map((question) => ({ question, exempt: true })),
        ...[...strangers, ...worth].map((question) => ({ question, exempt: false })),
    ];

    for (const { question, exempt } of ordered) {
        if (known.has(questionKey(question))) {
            continue;
        }

        if (!exempt && left <= 0) {
            break;
        }

        left -= exempt ? 0 : 1;
        known.add(questionKey(question));
        const asked = meetingItemSchema.parse({ ...question, id: nextId("i", taken), suggestedAt: options.now });
        taken.push(asked);
        fresh.push(asked);
    }

    // Every repeated unknown word no question decides yet: after the budgeted ones, most heard first (M3).
    if (options.rules.includes("terms")) {
        const minOccurrences = options.wordQuestions?.minOccurrences ?? DEFAULT_WORD_MIN_OCCURRENCES;

        for (const question of wordQuestions(taken, context, minOccurrences)) {
            if (known.has(questionKey(question))) {
                continue;
            }

            known.add(questionKey(question));
            const asked = meetingItemSchema.parse({ ...question, id: nextId("i", taken), suggestedAt: options.now });
            taken.push(asked);
            fresh.push(asked);
        }
    }

    record.items.push(...fresh);
    if (options.quality && options.rules.includes("evidence")) {
        addQualityQuestions({
            record,
            entries: options.meeting.transcript,
            speakers,
            below: Math.max(0.7, options.applyAbove ?? DEFAULT_APPLY_ABOVE),
            channel: record.evidence?.channels?.layout === "right-mic" ? 0 : 1,
            now: options.now,
            ...options.quality,
        });
    }
}

type StayEdit = {
    name: string;
    before: MeetingRecord["participants"][number]["stays"];
    after: MeetingRecord["participants"][number]["stays"];
};

function suggestionInputKey(record: MeetingRecord): string {
    // Attendance lookup also records diagnostic history. It does not change the evidence in this plan.
    const { history: _history, ...inputs } = record;
    return sha256Json(inputs);
}

export interface SuggestChanges {
    meeting: string;
    expected: string;
    fresh: MeetingItem[];
    updated: Array<{ id: string; before: MeetingItem; after: MeetingItem }>;
    stays: StayEdit[];
}

export function planSuggestions(inputs: SuggestInputs): SuggestChanges {
    const source = inputs.record;
    // Only these two collections have writers in the rules. Large saved evidence stays shared and read-only.
    const draft = {
        ...source,
        items: structuredClone(source.items),
        participants: structuredClone(source.participants),
    };
    if (inputs.retireTerms && inputs.rules.includes("terms") && inputs.termThresholds) {
        const reasons = settledTermItems({
            record: draft,
            dictionary: inputs.dictionary,
            known: knownWord(inputs.wordCheck),
            minOccurrences: inputs.wordQuestions?.minOccurrences ?? DEFAULT_WORD_MIN_OCCURRENCES,
            unknownCandidate: inputs.termThresholds.unknownCandidate,
        });
        for (const item of draft.items) {
            const reason = reasons.get(item.id);
            if (reason) {
                item.status = "rejected";
                item.decidedAt = inputs.now;
                item.evidence = { ...item.evidence, retired: reason };
            }
        }

        restoreThresholdRetirements({
            record: draft,
            dictionary: inputs.dictionary,
            unknownCandidate: inputs.termThresholds.unknownCandidate,
        });
    }
    buildSuggestions({ ...inputs, record: draft });
    return {
        meeting: source.id,
        expected: suggestionInputKey(source),
        fresh: draft.items.slice(source.items.length),
        updated: source.items.flatMap((before, i) => {
            const after = draft.items[i]!;
            return Bun.deepEquals(before, after) ? [] : [{ id: before.id, before: structuredClone(before), after }];
        }),
        stays: source.participants.flatMap((person, i) => {
            const after = draft.participants[i]!.stays;
            return Bun.deepEquals(person.stays, after)
                ? []
                : [{ name: person.name, before: structuredClone(person.stays), after }];
        }),
    };
}

/** Check every precondition before the first write, including IDs allocated for question targets. */
export function applySuggestionChanges(current: MeetingRecord, changes: SuggestChanges): void {
    const indices = new Map(current.items.map((item, index) => [item.id, index]));
    const people = new Map(current.participants.map((person) => [person.name, person]));
    if (
        current.id !== changes.meeting ||
        suggestionInputKey(current) !== changes.expected ||
        changes.fresh.some((item) => indices.has(item.id)) ||
        changes.updated.some(({ id, before }) => !Bun.deepEquals(current.items[indices.get(id) ?? -1], before)) ||
        changes.stays.some(({ name, before }) => !people.has(name) || !Bun.deepEquals(people.get(name)?.stays, before))
    ) {
        throw new Error("Meeting changed since suggestion planning. Run suggest again.");
    }
    for (const { id, after } of changes.updated) {
        current.items[indices.get(id)!] = structuredClone(after);
    }
    for (const { name, after } of changes.stays) {
        people.get(name)!.stays = structuredClone(after);
    }
    current.items.push(...structuredClone(changes.fresh));
}

export function suggestItems(options: SuggestInputs): MeetingItem[] {
    return planSuggestions(options).fresh;
}
