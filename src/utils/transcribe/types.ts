/** A person in a transcript. `speakerId` links them to the source's diarization number. */
export interface Participant {
    /** The diarization speaker number, when this person was assigned to one. */
    speakerId?: number;
    name: string;
    origin?: string;
    isSelf?: boolean;
}

/** One line of a transcript, whatever source recorded it. */
export interface TranscriptEntry {
    id?: string;
    /** Seconds from the start of the recording, when the source records it. */
    startSec?: number;
    speakerId?: number;
    speaker: string;
    text: string;
}
