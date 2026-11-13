import type { EchoMetric } from "@genesiscz/utils/meetings/echo";
/**
 * The facts of a meeting for an agent to reason over (the polishing session's three-pass mode, decision 33 a): who
 * was in the call, and per line what was said, under which label, on which channel, and what the platform showed.
 * No rule, no weight, no confidence: the agent decides, and writes items with its own reasons.
 */
import type { PairedPerson } from "@genesiscz/utils/meetings/people";
import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import { type MeetingSeats, personForAlias } from "@genesiscz/utils/meetings/seats";
import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { formatClock } from "@genesiscz/utils/transcribe/render";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { SummaryPoint } from "@genesiscz/utils/transcribe/summary";
import type { RawTermEvidence } from "@genesiscz/utils/transcribe/terms";
import { type IndicatorGap, indicatorFacts, type LabelPrehistory } from "./indicator-facts";
import { type LocalSpeech, localSpeechLines } from "./local-speech";
import { rosterPresence } from "./person-stays";
import { assessIndicator } from "./speaker-indicator";

export interface RawMeeting {
    indicator?: { knownLines: number; unknownLines: number };
    meeting: {
        id: string;
        seats?: MeetingSeats;
        indicator?: { signal: "no-signal"; dominant: { name: string; share: number } };
        title: string;
        start: string;
        end?: string;
        platform?: string;
        channelLayout?: string;
        /**
         * The stretches where the call's channel stayed silent while the microphone heard speech: the call played
         * through the room, so the channel cannot tell the user from the others there.
         */
        callSilent?: Array<{ fromSec: number; toSec: number }>;
        indicatorGaps?: IndicatorGap[];
        labels?: LabelPrehistory[];
    };
    people: Array<{
        name: string;
        origin?: string;
        role?: string;
        aliases?: string[];
        self?: boolean;
        firstSeenSec?: number;
        stays: Array<{ fromSec: number; toSec: number; source?: string; confidence?: number }>;
    }>;
    lines: Array<{
        index: number;
        fromSec: number;
        toSec: number;
        label: string;
        labelOrigin?: string;
        text: string;
        /** The microphone's share of the line's channel segments; absent when no segment overlaps it. */
        channel: { micShare: number | null };
        energyMicShare?: number;
        rawEnergyMicShare?: number;
        acoustic?: EchoMetric;
        acousticQuality?: EchoMetric["quality"] | "unknown";
        liveName?: string;
        /** Everyone the platform showed speaking during the line, most often first. */
        speaking: string[];
        speakingUnknown?: boolean;
        indicatorIgnored?: "meeting-dominance" | "stretch-stuck";
        indicatorReason?: "meeting-dominance" | "stretch-stuck";
        speakingSignal?: "no-signal";
        speakingSignalReason?: "meeting-dominance" | "stretch-stuck";
        muted: string[];
        localSpeechOutput?: true;
        present: string[];
    }>;
    /** The term part: the word check, the vocabulary, every run heard near a term, and the words no layer knows. */
    terms?: RawTermEvidence;
    context: Array<{ kind: string; ref: string }>;
    summary?: { text: string; points: SummaryPoint[] };
}

/** Who is present at a second: the record's sections when it has them, else the attendance stays. */
function presentAt(record: MeetingRecord, presence: Presence[] | undefined, sec: number): string[] {
    const section =
        presence === undefined ? record.sections?.find((part) => sec >= part.fromSec && sec <= part.toSec) : undefined;

    if (section) {
        return section.present;
    }

    return [
        ...new Set((presence ?? []).filter((stay) => sec >= stay.fromSec && sec < stay.toSec).map((stay) => stay.name)),
    ];
}

export function rawMeeting(options: {
    localSpeech?: LocalSpeech[];
    record: MeetingRecord;
    meeting: SourceMeeting;
    evidence: MeetingEvidence | null;
    presence?: Presence[];
    energyMicShare?: (fromSec: number, toSec: number) => number | undefined;
    callSilent?: Array<{ fromSec: number; toSec: number }>;
    points: SummaryPoint[];
    people?: PairedPerson[];
    terms?: RawTermEvidence;
}): RawMeeting {
    const { record, meeting, evidence } = options;
    const roster = rosterPresence(record, Math.max(...meeting.transcript.map((entry) => (entry.startSec ?? 0) + 5), 0));
    const presence = options.presence ?? (roster.length ? roster : record.attendance?.people);
    const originOf = (label: string) =>
        meeting.speakers.find((speaker) => sameName(speaker.name, label))?.origin ?? undefined;
    const lines = lineEvidence(
        meeting.transcript,
        evidence ?? { segments: [], speaking: [] },
        presence,
        options.energyMicShare
    );
    const selfName = record.participants.find((person) => person.self)?.name;
    const facts = indicatorFacts(options);
    const assessment = assessIndicator({
        lines,
        selfName: selfName ?? evidence?.selfName ?? "",
        roomPeople: record.seats?.room,
    });
    const local = new Set(
        localSpeechLines({
            transcript: meeting.transcript,
            start: meeting.start,
            calls: options.localSpeech ?? [],
        }).map((line) => line.index)
    );
    const names = [
        ...new Set([
            ...(presence?.map((person) => person.name) ?? []),
            ...record.participants.map((person) => person.name),
            ...(record.seats?.room ?? []),
            ...(record.seats?.remote.map((person) => person.name) ?? []),
            ...meeting.speakers.map((speaker) => speaker.name),
            ...facts.people.filter(
                (name) =>
                    !record.participants.some((person) => sameName(person.name, name)) &&
                    !meeting.speakers.some((speaker) => sameName(speaker.name, name))
            ),
        ]),
    ];

    return {
        meeting: {
            id: record.id,
            ...(record.seats ? { seats: record.seats } : {}),
            ...(assessment.dominant
                ? { indicator: { signal: "no-signal" as const, dominant: assessment.dominant } }
                : {}),
            title: record.title,
            start: meeting.start,
            ...(meeting.end ? { end: meeting.end } : {}),
            ...(record.platform ? { platform: record.platform } : {}),
            ...(record.evidence?.channels ? { channelLayout: record.evidence.channels.layout } : {}),
            ...(options.callSilent ? { callSilent: options.callSilent } : {}),
            indicatorGaps: facts.gaps,
            labels: facts.labels,
        },
        indicator: {
            knownLines: lines.filter((line) => !line.speakingUnknown).length,
            unknownLines: lines.filter((line) => line.speakingUnknown).length,
        },
        people: names.map((name) => {
            const origin = record.participants
                .find((person) => sameName(person.name, name))
                ?.from.includes("platform-roster")
                ? "platform-roster"
                : (originOf(name) ?? (facts.people.some((person) => sameName(person, name)) ? "indicator" : undefined));
            const person = record.participants.find((one) => sameName(one.name, name));
            const details = personForAlias(options.people ?? [], name);
            return {
                name,
                ...(person?.firstSeenSec === undefined ? {} : { firstSeenSec: person.firstSeenSec }),
                ...(details?.role ? { role: details.role } : {}),
                ...(details?.aliases ? { aliases: details.aliases } : {}),
                ...(origin ? { origin } : {}),
                ...(selfName && sameName(name, selfName) ? { self: true } : {}),
                stays: (presence ?? [])
                    .filter((stay) => sameName(stay.name, name))
                    .map((stay) => {
                        const stored = person?.stays?.find((one) => one.fromSec === stay.fromSec);
                        return {
                            fromSec: stay.fromSec,
                            toSec: stay.toSec,
                            ...(stored
                                ? {
                                      source: stored.source,
                                      ...(stored.confidence === undefined ? {} : { confidence: stored.confidence }),
                                  }
                                : {}),
                        };
                    }),
            };
        }),
        lines: lines.map((line) => {
            const origin = originOf(line.label);
            return {
                index: line.index,
                ...(local.has(line.index) ? { localSpeechOutput: true as const } : {}),
                ...(assessment.ignored.has(line.index)
                    ? { speakingSignal: "no-signal" as const, speakingSignalReason: assessment.reasons.get(line.index) }
                    : {}),
                fromSec: line.startSec,
                toSec: line.endSec,
                label: line.label,
                ...(origin ? { labelOrigin: origin } : {}),
                text: line.text,
                channel: { micShare: line.micShare === undefined ? null : Math.round(line.micShare * 1000) / 1000 },
                ...(line.energyMic !== undefined ? { energyMicShare: Math.round(line.energyMic * 1000) / 1000 } : {}),
                ...(line.energyMicRaw !== undefined ? { rawEnergyMicShare: line.energyMicRaw } : {}),
                ...(line.acoustic ? { acoustic: line.acoustic } : {}),
                acousticQuality: line.acousticQuality ?? "unknown",
                ...(line.liveName ? { liveName: line.liveName } : {}),
                speaking: Object.entries(line.speaking)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name]) => name),
                speakingUnknown: line.speakingUnknown,
                muted: line.muted ?? [],
                ...(assessment.reasons.has(line.index) ? { indicatorIgnored: assessment.reasons.get(line.index) } : {}),
                ...(assessment.reasons.has(line.index) ? { indicatorReason: assessment.reasons.get(line.index) } : {}),
                present: presentAt(record, presence, line.startSec),
            };
        }),
        ...(options.terms === undefined ? {} : { terms: options.terms }),
        context: record.context.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
        ...(meeting.summary ? { summary: { text: meeting.summary, points: options.points } } : {}),
    };
}

/** Stable short identifiers avoid ambiguous initials and delimiter-bearing person names. */
export function compactEvidence(raw: RawMeeting): string {
    const names = [...new Set(raw.lines.flatMap((line) => [line.label, ...line.speaking, ...line.muted]))];
    const short = new Map(names.map((name, index) => [name, `p${index + 1}`]));
    const legend = names.map((name) => `${short.get(name)}=${name}`).join("; ");
    const rows = raw.lines.map(
        (line) =>
            `${line.index}|${formatClock(line.fromSec)}|${short.get(line.label)}|mic${line.channel.micShare === null ? "?" : `${Math.round(line.channel.micShare * 100)}%`}|e${line.energyMicShare ?? "?"}|s[${line.speaking.map((name) => short.get(name)).join(",")}]|m[${line.muted.map((name) => short.get(name)).join(",")}]|${[...line.text.replace(/\r?\n/g, " ")].slice(0, 48).join("")}`
    );
    return [`Legend: ${legend}`, ...rows].join("\n");
}
