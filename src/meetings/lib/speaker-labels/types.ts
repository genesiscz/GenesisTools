import type { MeetingRule } from "@genesiscz/utils/meetings/rules";
import type { MeetingSound, Seat } from "../sound";

export const SPEAKER_LABELER_IDS = ["seat", "voice"] as const;
export type SpeakerLabelerId = (typeof SPEAKER_LABELER_IDS)[number];

export interface LineLabel {
    labeler: SpeakerLabelerId;
    index: number;
    seat: Seat;
    person?: string;
    score?: number;
    next?: { person: string; score: number };
    reason:
        | "named"
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
    lines: readonly { index: number; fromSec: number; toSec: number; seat: Seat }[];
    /** People who attended, with the seat each holds in this meeting and the time they were there. */
    attended: readonly { person: string; seat: Seat | undefined; fromSec: number; toSec: number }[];
    sound: MeetingSound;
    project: string | undefined;
}

export interface SpeakerLabeler {
    readonly id: SpeakerLabelerId;
    readonly rule: MeetingRule;
    propose(context: LabelContext): Promise<LineLabel[]>;
}
