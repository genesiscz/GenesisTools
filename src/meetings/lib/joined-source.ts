import type { JoinPart, MeetingParticipant, MeetingRecord } from "@genesiscz/utils/meetings/record";
import type { MeetingEvidence, SourceMeeting, TranscriptSource } from "@genesiscz/utils/meetings/sources";
import type { EvidenceSegment, SpeakingObservation } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { Participant, TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { toJoinedSec } from "./join-clock";

/** Opens a meeting source by its id (`meetingSource`); a test passes a fake one. */
export type SourceOpener = (sourceId: string) => Promise<TranscriptSource>;

/** The label a part's own speaker label carries on the joined record (`JoinPart.speakerLabels`), else the same label. */
export function partSpeakerLabel(part: Pick<JoinPart, "speakerLabels">, label: string): string {
    const labels = part.speakerLabels;
    return labels && Object.hasOwn(labels, label) ? labels[label]! : label;
}

/**
 * One recording's transcript on the joined clock: every start and word time moved by the part's offset, every line
 * tagged with its source meeting and under its joined speaker label, and the last line ended where it ended alone, so it
 * never runs over the gap into the next recording's first line.
 */
export function joinedTranscript(part: JoinPart, transcript: readonly TranscriptEntry[]): TranscriptEntry[] {
    const lines = new TranscriptLines(transcript);
    const last = lines.entries.findLastIndex((entry) => entry.startSec !== undefined && entry.text.trim() !== "");
    return transcript.map((entry, index) => {
        const ownEnd = index === last ? lines.end(index) : entry.endSec;
        return {
            ...entry,
            speaker: partSpeakerLabel(part, entry.speaker),
            sourceMeetingId: part.sourceMeetingId,
            ...(entry.startSec === undefined ? {} : { startSec: toJoinedSec(entry.startSec, part.offsetMs) }),
            ...(ownEnd === undefined ? {} : { endSec: toJoinedSec(ownEnd, part.offsetMs) }),
            ...(entry.words
                ? {
                      words: entry.words.map((word) => ({
                          ...word,
                          startSec: toJoinedSec(word.startSec, part.offsetMs),
                          endSec: toJoinedSec(word.endSec, part.offsetMs),
                      })),
                  }
                : {}),
        };
    });
}

function movedSegments(segments: readonly EvidenceSegment[], part: JoinPart): EvidenceSegment[] {
    return segments.map((segment) => ({
        ...segment,
        startSec: toJoinedSec(segment.startSec, part.offsetMs),
        endSec: toJoinedSec(segment.endSec, part.offsetMs),
    }));
}

function movedReadings(readings: readonly SpeakingObservation[], part: JoinPart): SpeakingObservation[] {
    return readings.map((reading) => ({
        ...reading,
        tSec: toJoinedSec(reading.tSec, part.offsetMs),
        ...(reading.validUntilSec === undefined
            ? {}
            : { validUntilSec: toJoinedSec(reading.validUntilSec, part.offsetMs) }),
    }));
}

function movedParticipants(people: readonly MeetingParticipant[], part: JoinPart): MeetingParticipant[] {
    return people.map((person) => ({
        ...person,
        ...(person.firstSeenSec === undefined ? {} : { firstSeenSec: toJoinedSec(person.firstSeenSec, part.offsetMs) }),
        ...(person.stays
            ? {
                  stays: person.stays.map((stay) => ({
                      ...stay,
                      ...(stay.fromSec === undefined ? {} : { fromSec: toJoinedSec(stay.fromSec, part.offsetMs) }),
                      ...(stay.toSec === undefined ? {} : { toSec: toJoinedSec(stay.toSec, part.offsetMs) }),
                  })),
              }
            : {}),
    }));
}

function byName<T extends { name: string }>(lists: readonly T[][]): T[] {
    const seen = new Map<string, T>();

    for (const one of lists.flat()) {
        if (!seen.has(one.name)) {
            seen.set(one.name, one);
        }
    }

    return [...seen.values()];
}

/** The parts' meetings as one meeting on the joined clock. */
export function joinedMeeting(
    record: MeetingRecord,
    parts: readonly JoinPart[],
    meetings: readonly SourceMeeting[]
): SourceMeeting {
    const first = meetings[0]!;
    const summaries = meetings
        .map((meeting) => meeting.summary?.trim())
        .filter((text): text is string => Boolean(text));
    const observations = meetings.flatMap((meeting, index) => movedReadings(meeting.observations ?? [], parts[index]!));
    const calendar = meetings.find((meeting) => meeting.calendar)?.calendar;
    return {
        sourceMeetingId: first.sourceMeetingId,
        title: record.title,
        start: first.start,
        ...(meetings.at(-1)?.end ? { end: meetings.at(-1)?.end } : {}),
        participants: byName(meetings.map((meeting, index) => movedParticipants(meeting.participants, parts[index]!))),
        ...(observations.length > 0 ? { observations } : {}),
        speakers: byName<Participant>(
            meetings.map((meeting, index) =>
                meeting.speakers.map((speaker) => ({ ...speaker, name: partSpeakerLabel(parts[index]!, speaker.name) }))
            )
        ),
        transcript: meetings.flatMap((meeting, index) => joinedTranscript(parts[index]!, meeting.transcript)),
        ...(calendar ? { calendar } : {}),
        folders: [...new Set(meetings.flatMap((meeting) => meeting.folders))],
        ...(summaries.length > 0 ? { summary: summaries.join("\n\n") } : {}),
    };
}

/**
 * The parts' evidence as one: segments and speaking readings on the joined clock, and no `audioPath`: the joined
 * record's own source file (`audio.sources`, put together by the join) is the one a reader gets. Null when no part has
 * evidence.
 */
export function joinedEvidence(
    parts: readonly JoinPart[],
    evidence: ReadonlyArray<MeetingEvidence | null>
): MeetingEvidence | null {
    const present = evidence.flatMap((one, index) => (one ? [{ one, part: parts[index]! }] : []));

    if (present.length === 0) {
        return null;
    }

    const first = (pick: (one: MeetingEvidence) => unknown) =>
        present.map(({ one }) => pick(one)).find((value) => value !== undefined);
    const tokens = present.reduce(
        (sum, { one }) =>
            one.tokens ? { mic: sum.mic + one.tokens.mic, system: sum.system + one.tokens.system } : sum,
        { mic: 0, system: 0 }
    );
    const selfName = first((one) => one.selfName) as string | undefined;
    const platform = first((one) => one.platform) as string | undefined;
    const mutedCarrySec = first((one) => one.mutedCarrySec) as number | undefined;
    const devices = first((one) => one.devices) as Record<string, unknown> | undefined;
    const participants = present.flatMap(({ one, part }) => movedParticipants(one.participants ?? [], part));
    return {
        ...(selfName ? { selfName } : {}),
        ...(platform ? { platform } : {}),
        segments: present.flatMap(({ one, part }) => movedSegments(one.segments, part)),
        speaking: present.flatMap(({ one, part }) => movedReadings(one.speaking, part)),
        ...(mutedCarrySec === undefined ? {} : { mutedCarrySec }),
        ...(participants.length > 0 ? { participants: byName([participants]) } : {}),
        ...(present.some(({ one }) => one.tokens) ? { tokens } : {}),
        ...(devices ? { devices } : {}),
        files: present.flatMap(({ one }) => one.files),
    };
}

/**
 * The source of a joined record: each method asks the parts' own source meetings and answers on the joined clock.
 * The meeting id it is asked with is ignored; the record's parts name the source meetings.
 */
export async function joinedSource(record: MeetingRecord, open: SourceOpener): Promise<TranscriptSource> {
    const parts = record.join?.parts ?? [];
    const base = await open(parts[0]!.sourceId);
    const sources = await Promise.all(parts.map((part) => (part.sourceId === base.id ? base : open(part.sourceId))));
    return {
        ...base,
        load: async () =>
            joinedMeeting(
                record,
                parts,
                await Promise.all(parts.map((part, index) => sources[index]!.load(part.sourceMeetingId)))
            ),
        revision: async () => {
            const revisions = await Promise.all(
                parts.map((part, index) => sources[index]!.revision(part.sourceMeetingId))
            );
            return revisions.some((one) => one === null) ? null : revisions.join("+");
        },
        recordingClock: async () => ({ startedAt: parts[0]!.zeroAt }),
        evidence: async () =>
            joinedEvidence(
                parts,
                await Promise.all(
                    parts.map((part, index) =>
                        sources[index]!.evidence(part.sourceMeetingId).catch((error: unknown) => {
                            // A part whose source no longer reads still plays from its preserved sound.
                            if (!part.audio) {
                                throw error;
                            }
                            return null;
                        })
                    )
                )
            ),
        meetingFolders: async () => {
            const folders = await Promise.all(
                parts.map((part, index) => sources[index]!.meetingFolders(part.sourceMeetingId))
            );
            return folders.some((one) => one === null) ? null : [...new Set(folders.flatMap((one) => one ?? []))];
        },
    };
}
