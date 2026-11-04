import type { CalendarPerson } from "@genesiscz/utils/meetings/calendar-entry";
import type { Participant, TranscriptEntry } from "@genesiscz/utils/transcribe/types";

export type SourceName = "local" | "mcp";
export type SourceChoice = SourceName | "auto";

export interface Folder {
    id: string;
    name: string;
}

export interface MeetingSummary {
    id: string;
    title: string;
    start: string;
    end?: string;
    modifiedAt?: string;
    hasTranscript: boolean;
    shareLink?: string;
    folders: Folder[];
    excerpt?: string;
}

export interface Meeting extends MeetingSummary {
    summary: string;
    notes: string;
    participants: Participant[];
    transcript: TranscriptEntry[];
    /** True when a speaker rename exists on this Mac but the app has not sent it to the server yet. */
    speakerRenamePending?: boolean;
    /** Set when the app's refined transcript stops before the recording does; the rest is unrefined live text. */
    transcriptGap?: TranscriptGap;
}

export interface TranscriptGap {
    refinedUntilSec: number;
    liveUntilSec: number;
    appendedLines: number;
}

export interface Sourced<T> {
    source: SourceName;
    data: T;
    /** Why the other source did not answer, or where the two disagree. */
    notes: string[];
}

export interface ScratchpadNote {
    id: string;
    title: string;
    modifiedAt: string;
    content?: string;
    excerpt?: string;
}

export interface CalendarEvent {
    id: string;
    title: string;
    start: string;
    end: string;
    conferenceUrl?: string;
    attendees: string[];
    /** The attendees with their emails where the calendar gives them. */
    people?: CalendarPerson[];
}
