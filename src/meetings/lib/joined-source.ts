import { logger } from "@genesiscz/utils/logger";
import type { JoinPart, MeetingParticipant, MeetingRecord } from "@genesiscz/utils/meetings/record";
import type {
    MeetingEvidence,
    RecordingClock,
    SourceMeeting,
    TranscriptSource,
} from "@genesiscz/utils/meetings/sources";
import type { EvidenceSegment, SpeakingObservation } from "@genesiscz/utils/transcribe/evidence";
import { TranscriptLines } from "@genesiscz/utils/transcribe/lines";
import type { Participant, TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import { toJoinedSec } from "./join-clock";
import { recordingCopyFolder, type SourceCopyRef, saveSourceCopy } from "./source-copy";

const { log } = logger.scoped("meetings-join");

/** The label a part's own speaker label carries on the joined record (`JoinPart.speakerLabels`), else the same label. */
export function partSpeakerLabel(part: Pick<JoinPart, "speakerLabels">, label: string): string {
    const labels = part.speakerLabels;
    return labels && Object.hasOwn(labels, label) ? labels[label]! : label;
}

/** One recording and the record it was: its source meeting and its old folder (`recordingSource`; a test fakes it). */
export type RecordingRef = Pick<JoinPart, "record" | "sourceId" | "sourceMeetingId">;

/** Opens one recording's own source (`recordingSource` in production; a test passes a fake one). */
export type RecordingOpener = (recording: RecordingRef) => Promise<TranscriptSource>;

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
 * The ref a joined record's own copy is saved under (source-copy.ts): the first recording's source and its
 * recordings' meeting ids in time order, joined by "+". No single source meeting has that id, so a read of one
 * recording never takes the joined copy for its own, and the joined copy never answers for one recording.
 */
export function joinedCopyRef(parts: readonly JoinPart[]): SourceCopyRef {
    return { sourceId: parts[0]!.sourceId, sourceMeetingId: parts.map((part) => part.sourceMeetingId).join("+") };
}

/** Each recording's meeting, evidence and clock, read once from its own source by the join or its repair. */
export interface JoinedReads {
    meetings: SourceMeeting[];
    /** Null for a recording whose source keeps no evidence now but whose sound the record kept. */
    evidence: Array<MeetingEvidence | null>;
    /** Null when the source keeps no clock or could not answer it now. */
    clocks: Array<RecordingClock | null>;
}

/**
 * Reads each recording once. A meeting that cannot be read throws, so nothing is written from half a meeting; the
 * evidence of a recording whose sound the record kept may be missing (it is read as none).
 */
export async function readJoinedParts(parts: readonly JoinPart[], open: RecordingOpener): Promise<JoinedReads> {
    const sources = await Promise.all(parts.map((part) => open(part)));
    const [meetings, evidence, clocks] = await Promise.all([
        Promise.all(parts.map((part, index) => sources[index]!.load(part.sourceMeetingId))),
        Promise.all(
            parts.map((part, index) =>
                sources[index]!.evidence(part.sourceMeetingId).catch((error: unknown) => {
                    if (!part.audio) {
                        throw error;
                    }

                    return null;
                })
            )
        ),
        Promise.all(
            parts.map((part, index) =>
                sources[index]!.recordingClock(part.sourceMeetingId).catch((error: unknown) => {
                    log.debug({ error, sourceMeetingId: part.sourceMeetingId }, "join: no recording clock to keep");
                    return null;
                })
            )
        ),
    ]);
    return { meetings, evidence, clocks };
}

/**
 * Saves the joined meeting as the joined record's own copy (`joinedCopyRef`): the meeting on the joined clock, the
 * evidence and the first recording's clock. First each recording's own answer is kept as that recording's copy
 * (`recordingCopyFolder`), because the joined copy takes the place of the first recording's copy in this folder and a
 * reading of one recording (a polished file's part) falls back on it. The joined meeting is written last: its header
 * is what says the record owns a copy (`hasSourceCopy`), so a write cut short leaves the record as it was. Writes
 * nothing when the copies are the same. `record` must carry its `join`.
 */
export function saveJoinedCopy(options: { folder: string; record: MeetingRecord; reads: JoinedReads }): {
    lines: number;
    written: boolean;
} {
    const { folder, record, reads } = options;
    const parts = record.join?.parts ?? [];

    if (parts.length < 2) {
        throw new Error(`${record.id} is not a joined meeting; it has no joined transcript to keep.`);
    }

    const ref = joinedCopyRef(parts);
    const meeting = joinedMeeting(record, parts, reads.meetings);
    const recordings = parts.map((part, index) => saveRecordingCopy(folder, part, reads, index)).some(Boolean);
    const evidence = saveSourceCopy(folder, "evidence", ref, joinedEvidence(parts, reads.evidence));
    const clock = saveSourceCopy(folder, "clock", ref, { startedAt: parts[0]!.zeroAt });
    const saved = saveSourceCopy(folder, "meeting", ref, meeting);
    return { lines: meeting.transcript.length, written: recordings || evidence || clock || saved };
}

/** One recording's own copy, as its source answered it alone; a part it could not answer is not saved. */
function saveRecordingCopy(folder: string, part: JoinPart, reads: JoinedReads, index: number): boolean {
    const holder = recordingCopyFolder(folder, part.sourceMeetingId);
    const ref = { sourceId: part.sourceId, sourceMeetingId: part.sourceMeetingId };
    const evidence = reads.evidence[index];
    const clock = reads.clocks[index];
    const written = [
        evidence ? saveSourceCopy(holder, "evidence", ref, evidence) : false,
        clock ? saveSourceCopy(holder, "clock", ref, clock) : false,
        saveSourceCopy(holder, "meeting", ref, reads.meetings[index]!),
    ];
    return written.some(Boolean);
}
