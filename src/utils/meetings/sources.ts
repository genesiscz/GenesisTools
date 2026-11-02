import type { EvidenceSegment, SpeakingObservation } from "@genesiscz/utils/transcribe/evidence";
import type { Participant, TranscriptEntry } from "@genesiscz/utils/transcribe/types";
import type { MeetingCalendar, MeetingParticipant } from "./record";

/** The sources a meeting's transcript can come from. A new source is one entry here and one implementation. */
export const MEETING_SOURCE_IDS = ["wisprflow"] as const;
export type MeetingSourceId = (typeof MEETING_SOURCE_IDS)[number];

/** What a source knows about one of its meetings, in the shape every meeting command reads. */
export interface SourceMeeting {
    sourceMeetingId: string;
    title: string;
    start: string;
    end?: string;
    participants: MeetingParticipant[];
    /** The diarized speakers with their number and who named them (platform, llm, self). */
    speakers: Participant[];
    transcript: TranscriptEntry[];
    /** The calendar event the source links the meeting to, when it has one. */
    calendar?: MeetingCalendar;
    /** Words that help a project match: the source's folders, for example. */
    folders: string[];
}

/** A word the source was taught to spell, for `dictionary suggest`. */
export interface DictionaryCandidate {
    value: string;
    replacement?: string;
}

/** Where a recording's transcript clock starts, so a screen frame's wall time maps to a transcript second. */
export interface RecordingClock {
    /** Wall time of transcript second 0. */
    startedAt: string;
}

/** Raw speaker evidence a source keeps beside its transcript. Times are on the transcript clock. */
export interface MeetingEvidence {
    /** The recording user's name, as the source knows it. */
    selfName?: string;
    segments: EvidenceSegment[];
    speaking: SpeakingObservation[];
    /** Words recognized per channel: the user's share of the speech. */
    tokens?: { mic: number; system: number };
    /** The audio setup, as the source recorded it. */
    devices?: Record<string, unknown>;
    /** The files the evidence came from, with their sizes, for a doctor view. */
    files: Array<{ name: string; bytes: number }>;
}

/** A recording the source is making right now. */
export interface LiveRecording {
    sourceMeetingId: string;
    title: string;
    startedAt: string;
    /** When the source last wrote to it; a recording silent for long has stopped. */
    liveChangedAt: string;
}

/**
 * One transcript source. Every member is required: a source that cannot answer says so in its implementation
 * (returns null or an empty list, with the reason in a comment).
 */
export interface TranscriptSource {
    readonly id: MeetingSourceId;
    /** A short name for messages. */
    readonly label: string;
    /** The source's meeting with its transcript. Throws when it does not exist. */
    load(sourceMeetingId: string): Promise<SourceMeeting>;
    /** The block this source writes under `meeting.sources.<id>`. Only this source reads it. */
    describe(meeting: SourceMeeting): Record<string, unknown>;
    /** The source's own word list. */
    dictionary(): Promise<DictionaryCandidate[]>;
    /** Where the source's transcript clock starts for this meeting; null when the source has no times. */
    recordingClock(sourceMeetingId: string): Promise<RecordingClock | null>;
    /** Speaker evidence beside the transcript (channels, the platform's speaking indicator); null when it keeps none. */
    evidence(sourceMeetingId: string): Promise<MeetingEvidence | null>;
    /** A recording running now, for the autostart; null when none is. */
    liveRecording(): Promise<LiveRecording | null>;
}
