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
    /** Accepted acoustic word timings, when supplied by the bounded local timing cache. */
    words?: Array<{ range: { location: number; length: number }; startSec: number; endSec: number; sourceId: string }>;
    speakerId?: number;
    speaker: string;
    text: string;
    confidence?: number;
    suggestedSpeaker?: string;
    nameSource?: "voice";
    nameScore?: number;
    /** Original source entry index when corrected/segmented entries carry per-line voice evidence. */
    sourceIndex?: number;
    questioned?: boolean;
    guess?: boolean;
    band?: "confirmed" | "applied" | "guess" | "open";
    /**
     * The open speaker question on this line, for a reader that draws it (the Meetings window): the source label it is
     * about and the answers on offer. `speaker` keeps the export's mark (`[unclear: "<label>"; 1) … 2) …]`).
     */
    unclear?: { label: string; readings: string[] };
    /** The voices a confirmed answer heard together on this line; `speaker` keeps the export's mark. */
    voices?: string[];
}
