import { existsSync, readFileSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingItem, type MeetingRecord, meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";
import type { DictionaryCandidate, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import { type Presence, type SpeakerHint, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { buildVocabulary, DEV_GLOSSARY, findSuspectTerms, termsFromText } from "@genesiscz/utils/transcribe/terms";

const { log } = logger.scoped("meetings-suggest");

export const SUGGEST_RULES = ["speakers", "terms"] as const;
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
                    rules: ["RA"],
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
                    rules: ["RA"],
                    evidence: { lines: range.lines, reason: `only ${hint.person} was in the call` },
                });
            }
        } else if (hint.kind === "leave-then-continues") {
            hint.leaves.forEach((leave, index) => {
                const until = hint.leaves[index + 1]?.atSec ?? lastSecOf.get(hint.label) ?? leave.continuesAtSec;
                const answered = Boolean(leave.confirmedBy || leave.echoOf);
                const base = answered ? CONFIDENCE.answeredLeave : CONFIDENCE.unansweredLeave;
                items.push({
                    kind: "speaker-range",
                    status: "suggested",
                    label: hint.label,
                    fromSec: leave.continuesAtSec,
                    toSec: until,
                    confidence: Math.min(1, base + (hint.strength === "strong" ? CONFIDENCE.llmBonus : 0)),
                    rules: ["R1", "R5", ...(leave.confirmedBy ? ["R13"] : []), ...(leave.echoOf ? ["R14"] : [])],
                    evidence: {
                        leaveAt: leave.atSec,
                        said: leave.text,
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

function termItems(options: {
    meeting: SourceMeeting;
    record: MeetingRecord;
    dictionary: ResolvedDictionary;
    sourceWords: DictionaryCandidate[];
}): NewItem[] {
    const { meeting, record, dictionary } = options;
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
    const vocab = buildVocabulary([
        DEV_GLOSSARY.map((term) => ({ term, source: "glossary" })),
        options.sourceWords.map((word) => ({ term: word.replacement ?? word.value, source: "source" })),
        dictionaryTerms,
        ...contextTexts,
    ]);
    const keep = new Set(
        dictionary.entries.filter((entry) => entry.type === "keep").map((entry) => entry.value.toLowerCase())
    );
    const suspects = findSuspectTerms({
        entries: meeting.transcript,
        vocab,
        context: termsFromText(meeting.title, "title"),
    }).filter((suspect) => !keep.has(suspect.heard.toLowerCase()));
    log.debug({ vocab: vocab.length, suspects: suspects.length, kept: keep.size }, "term suggestions");

    return suspects.flatMap((suspect) => {
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
                confidence: best.confidence / 100,
                rules: ["phonetic", best.source],
                evidence: {
                    occurrences: suspect.occurrences,
                    match: suspect.kind,
                    candidates: suspect.candidates.map((candidate) => `${candidate.term} ${candidate.confidence} %`),
                },
            },
        ];
    });
}

/** Two items say the same thing: the same kind on the same label, time or word. */
function itemKey(item: NewItem | MeetingItem): string {
    if (item.kind === "speaker-range") {
        return `range|${item.label}|${Math.round(item.fromSec)}|${Math.round(item.toSec)}|${item.speaker ?? ""}`;
    }

    if (item.kind === "join") {
        return `join|${Math.round(item.atSec)}`;
    }

    return `term|${item.heard.toLowerCase()}|${item.proposed}`;
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
        found.push(...speakerItems({ hints: stats.hints, selfName, selfAttendee, lastSecOf }));
    }

    if (options.rules.includes("terms")) {
        found.push(...termItems(options));
    }

    const known = new Set(record.items.map(itemKey));
    const fresh: MeetingItem[] = [];
    const taken = [...record.items];

    for (const item of found) {
        const key = itemKey(item);

        if (known.has(key)) {
            continue;
        }

        known.add(key);
        const withId = meetingItemSchema.parse({ ...item, id: nextId("i", taken), suggestedAt: options.now });
        taken.push(withId);
        fresh.push(withId);
    }

    return fresh;
}
