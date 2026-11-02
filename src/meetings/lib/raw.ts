import type { MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence, SourceMeeting } from "@genesiscz/utils/meetings/sources";
import { lineEvidence } from "@genesiscz/utils/transcribe/evidence";
import { type Presence, sameName } from "@genesiscz/utils/transcribe/speakers";
import type { SummaryPoint } from "@genesiscz/utils/transcribe/summary";

/**
 * The facts of a meeting for an agent to reason over (the polishing session's three-pass mode, decision 33 a): who
 * was in the call, and per line what was said, under which label, on which channel, and what the platform showed.
 * No rule, no weight, no confidence: the agent decides, and writes items with its own reasons.
 */
export interface RawMeeting {
    meeting: {
        id: string;
        title: string;
        start: string;
        end?: string;
        platform?: string;
        channelLayout?: string;
    };
    people: Array<{
        name: string;
        origin?: string;
        self?: boolean;
        stays: Array<{ fromSec: number; toSec: number }>;
    }>;
    lines: Array<{
        index: number;
        fromSec: number;
        toSec: number;
        label: string;
        labelOrigin?: string;
        text: string;
        /** The microphone's share of the line's channel segments; absent when no segment overlaps it. */
        channel?: { micShare: number };
        energyMicShare?: number;
        liveName?: string;
        /** Everyone the platform showed speaking during the line, most often first. */
        speaking: string[];
        muted: string[];
        present: string[];
    }>;
    /** The term part, filled by the term check (`rawTermEvidence`) once it exists. */
    terms?: unknown;
    context: Array<{ kind: string; ref: string }>;
    summary?: { text: string; points: SummaryPoint[] };
}

/** Who is present at a second: the record's sections when it has them, else the attendance stays. */
function presentAt(record: MeetingRecord, presence: Presence[] | undefined, sec: number): string[] {
    const section = record.sections?.find((part) => sec >= part.fromSec && sec <= part.toSec);

    if (section) {
        return section.present;
    }

    return [
        ...new Set(
            (presence ?? []).filter((stay) => sec >= stay.fromSec && sec <= stay.toSec).map((stay) => stay.name)
        ),
    ];
}

export function rawMeeting(options: {
    record: MeetingRecord;
    meeting: SourceMeeting;
    evidence: MeetingEvidence | null;
    presence?: Presence[];
    energyMicShare?: (fromSec: number, toSec: number) => number | undefined;
    points: SummaryPoint[];
    terms?: unknown;
}): RawMeeting {
    const { record, meeting, evidence } = options;
    const originOf = (label: string) =>
        meeting.speakers.find((speaker) => sameName(speaker.name, label))?.origin ?? undefined;
    const lines = lineEvidence(
        meeting.transcript,
        evidence ?? { segments: [], speaking: [] },
        options.presence,
        options.energyMicShare
    );
    const textAt = new Map(
        meeting.transcript.filter((entry) => entry.startSec !== undefined).map((entry) => [entry.startSec!, entry.text])
    );
    const selfName = record.participants.find((person) => person.self)?.name;
    const names = [
        ...new Set([
            ...(record.attendance?.people.map((person) => person.name) ?? []),
            ...record.participants.map((person) => person.name),
            ...meeting.speakers.map((speaker) => speaker.name),
        ]),
    ];

    return {
        meeting: {
            id: record.id,
            title: record.title,
            start: meeting.start,
            ...(meeting.end ? { end: meeting.end } : {}),
            ...(record.platform ? { platform: record.platform } : {}),
            ...(record.evidence?.channels ? { channelLayout: record.evidence.channels.layout } : {}),
        },
        people: names.map((name) => {
            const origin = originOf(name);
            return {
                name,
                ...(origin ? { origin } : {}),
                ...(selfName && sameName(name, selfName) ? { self: true } : {}),
                stays: (record.attendance?.people ?? [])
                    .filter((stay) => sameName(stay.name, name))
                    .map((stay) => ({ fromSec: stay.fromSec, toSec: stay.toSec })),
            };
        }),
        lines: lines.map((line) => {
            const origin = originOf(line.label);
            return {
                index: line.index,
                fromSec: line.startSec,
                toSec: line.endSec,
                label: line.label,
                ...(origin ? { labelOrigin: origin } : {}),
                text: textAt.get(line.startSec) ?? "",
                ...(line.micShare !== undefined
                    ? { channel: { micShare: Math.round(line.micShare * 1000) / 1000 } }
                    : {}),
                ...(line.energyMic !== undefined ? { energyMicShare: Math.round(line.energyMic * 1000) / 1000 } : {}),
                ...(line.liveName ? { liveName: line.liveName } : {}),
                speaking: Object.entries(line.speaking)
                    .sort((a, b) => b[1] - a[1])
                    .map(([name]) => name),
                muted: line.muted ?? [],
                present: presentAt(record, options.presence, line.startSec),
            };
        }),
        ...(options.terms === undefined ? {} : { terms: options.terms }),
        context: record.context.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
        ...(meeting.summary ? { summary: { text: meeting.summary, points: options.points } } : {}),
    };
}
