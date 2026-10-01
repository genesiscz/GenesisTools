export type SourceName = "local" | "mcp";
export type SourceChoice = SourceName | "auto";

export interface Folder {
    id: string;
    name: string;
}

export interface Participant {
    /** The diarization speaker number, when this person was assigned to one. */
    speakerId?: number;
    name: string;
    origin?: string;
    isSelf?: boolean;
}

export interface TranscriptEntry {
    id?: string;
    /** Seconds from the start of the recording, when the source records it. */
    startSec?: number;
    speakerId?: number;
    speaker: string;
    text: string;
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
}
