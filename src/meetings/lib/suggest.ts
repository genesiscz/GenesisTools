import { existsSync, readFileSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { type MeetingItem, type MeetingRecord, meetingItemSchema, nextId } from "@genesiscz/utils/meetings/record";
import type { DictionaryCandidate, MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import type { ResolvedDictionary } from "@genesiscz/utils/transcribe/dictionary";
import { type LineEvidence, lineEvidence, SELF } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, type SpeakerHint, sameName, speakerStats } from "@genesiscz/utils/transcribe/speakers";
import { buildVocabulary, DEV_GLOSSARY, findSuspectTerms, termsFromText } from "@genesiscz/utils/transcribe/terms";

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
function findingFor(line: LineEvidence, selfName: string, isSelfLabel: boolean): EvidenceFinding | undefined {
    if (line.micShare === undefined || !line.winner) {
        return undefined;
    }

    if (line.winner === SELF) {
        return isSelfLabel
            ? undefined
            : {
                  speaker: selfName,
                  rules: ["E1"],
                  confidence: line.micShare,
                  ...(line.micShare < CHANNEL_SHARE ? { listen: true } : {}),
              };
    }

    // The call's sound won the line. Some microphone in it means two voices: listen before confirming.
    const listen = line.micShare > 1 - CHANNEL_SHARE ? { listen: true } : {};
    const shown = speakingNames(line).filter((name) => !sameName(name, selfName));
    const present = line.present?.filter((name) => !sameName(name, selfName));
    const live =
        line.liveName && (!present || present.some((name) => sameName(name, line.liveName!)))
            ? line.liveName
            : undefined;
    const agreed = live && shown[0] && sameName(shown[0], live) ? live : undefined;

    if (isSelfLabel) {
        return agreed
            ? { speaker: agreed, rules: ["E1", "E3", "E4"], confidence: 0.8, ...listen }
            : { candidates: present ?? shown, rules: ["E1"], confidence: 0.6, ...listen };
    }

    if (agreed && !sameName(agreed, line.label)) {
        return { speaker: agreed, rules: ["E1", "E3", "E4"], confidence: 0.7, ...listen };
    }

    // RA: the label's own person was not in the call, so the platform's live name is the best guess left.
    const labelAbsent = present !== undefined && !present.some((name) => sameName(name, line.label));

    if (labelAbsent && live) {
        return { speaker: live, rules: ["E1", "E4", "RA"], confidence: 0.6, ...listen };
    }

    // The live name belongs to someone who had left: a live voice id keeps its last name after the person goes.
    // The speaking indicator among the people still in the call is the guess, sampled only every few seconds.
    const stillHere = shown.filter((name) => present?.some((person) => sameName(person, name)));

    if (labelAbsent && line.liveName && stillHere[0]) {
        return { speaker: stillHere[0], rules: ["E1", "E3", "RA"], confidence: 0.45, listen: true };
    }

    return undefined;
}

function evidenceItems(options: {
    meeting: SourceMeeting;
    evidence: MeetingEvidence;
    presence?: Presence[];
}): NewItem[] {
    const selfName = options.evidence.selfName;

    if (!selfName || options.evidence.segments.length === 0) {
        log.debug({ selfName, segments: options.evidence.segments.length }, "no channel evidence");
        return [];
    }

    // Teams attendance names the user by email; here the user is always `selfName`.
    const presence = options.presence?.map((stay) => (stay.self ? { ...stay, name: selfName } : stay));
    const lines = lineEvidence(options.meeting.transcript, options.evidence, presence);
    const items: NewItem[] = [];
    let open: { item: Extract<NewItem, { kind: "speaker-range" }>; key: string; shares: number[] } | undefined;
    const close = () => {
        if (open) {
            const mean = open.shares.reduce((sum, share) => sum + share, 0) / open.shares.length;
            open.item.confidence = Math.round(mean * 100) / 100;
            open.item.evidence = { ...open.item.evidence, lines: open.shares.length };
            items.push(open.item);
            open = undefined;
        }
    };
    const byLabel = new Map<string, LineEvidence[]>();

    for (const line of lines) {
        byLabel.set(line.label, [...(byLabel.get(line.label) ?? []), line]);
    }

    for (const [label, labelLines] of byLabel) {
        const isSelfLabel = sameName(label, selfName);

        for (const line of labelLines) {
            const finding = findingFor(line, selfName, isSelfLabel);
            const key = finding
                ? `${finding.speaker ?? ""}|${(finding.candidates ?? []).join(",")}|${finding.listen ? "listen" : ""}`
                : "";

            if (!finding) {
                continue;
            }

            if (open && open.key === key && line.startSec - open.item.toSec < EVIDENCE_GAP_SEC) {
                open.item.toSec = line.startSec;
                open.shares.push(finding.confidence);
                continue;
            }

            close();
            open = {
                key,
                shares: [finding.confidence],
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
                        ...(finding.listen ? { note: "both channels in these lines: confirm by listening" } : {}),
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
    evidence?: MeetingEvidence | null;
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

    if (options.rules.includes("evidence") && options.evidence) {
        found.push(...evidenceItems({ meeting, evidence: options.evidence, presence: options.presence }));
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
