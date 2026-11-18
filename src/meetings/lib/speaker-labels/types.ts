import type { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { MeetingSound, Seat } from "../sound";

export const SPEAKER_LABELER_IDS = ["seat", "voice"] as const;
export type SpeakerLabelerId = (typeof SPEAKER_LABELER_IDS)[number];

/**
 * The voice agrees with a seat label: the line, scored against the seat person's saved samples only, passes the voice
 * gate for that person. It is shown beside the seat's name and never changes the seat's confidence.
 */
export interface VoiceSupport {
    person: string;
    /** Cosine of the line against the person's saved samples (0 to 1). Not a probability. */
    score: number;
    next?: { person: string; score: number };
    /** The saved samples on the line's seat and track that the score compared with. */
    samples: number;
}

export interface LineLabel {
    labeler: SpeakerLabelerId;
    index: number;
    seat: Seat;
    person?: string;
    score?: number;
    /** Distance below the voice match threshold for the closest enrolled seat-mate. */
    margin?: number;
    next?: { person: string; score: number };
    /** A seat label of one person can carry the voice's agreement (`speakerLabels.voice.supportOnSeatLines`). */
    voiceSupport?: VoiceSupport;
    reason:
        | "named"
        | "exclusion"
        | "exclusion-not-one-voice"
        | "exclusion-too-few-lines"
        | "below-gate"
        | "no-rival-sample"
        | "unsampled-present"
        | "not-the-seat-person"
        | "no-voice"
        | "seat-of-one"
        | "seat-shared"
        | "seat-unknown";
}

export interface LabelContext {
    lines: readonly { index: number; fromSec: number; toSec: number; seat: Seat; energyMic?: number }[];
    /** People who attended, with the seat each holds in this meeting and the time they were there. */
    attended: readonly { person: string; seat: Seat | undefined; fromSec: number; toSec: number }[];
    /** A caller-supplied track selection. The voice labeler opens the meeting's sound on demand otherwise. */
    sound?: MeetingSound;
    /** Independent, single-speaker lines for this voice pass, keyed by source transcript index. */
    certain?: ReadonlyMap<number, string>;
    /** Sole occupancy is provisional if the project voice vetoes the seat owner. */
    seatOnlySeeds?: ReadonlySet<number>;
    /** Lines the seat labeler gave to the only person at their seat, keyed by source transcript index. */
    seatOwners?: ReadonlyMap<number, string>;
    applyAbove?: number;
    project: string | undefined;
}

export interface SpeakerLabeler {
    readonly id: SpeakerLabelerId;
    readonly rule: MeetingRule;
    propose(context: LabelContext): Promise<LineLabel[]>;
}
