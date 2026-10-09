import { SafeJSON } from "@genesiscz/utils/json";
import { speakerLabel } from "./speakers";
import type { Participant, TranscriptEntry, TranscriptGap } from "./types";

/** One line of the app's `live.ndjson`: the unrefined transcript written while the meeting runs. */
export interface LiveLine {
    id?: string;
    text?: string;
    speaker?: { id?: number; source?: string; name?: string | null };
    startRecordingMs?: number;
    endRecordingMs?: number;
}

/** The refined pass is allowed to end this much before the live recording without counting as cut off. */
const GAP_TOLERANCE_SEC = 30;

/**
 * The `timestamp` strings in `live.ndjson` run on different clocks per audio source (mic vs system),
 * so lines are placed by `startRecordingMs`, which both sources share.
 */
export function parseLive(raw: string): LiveLine[] {
    return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => SafeJSON.parse(line, { strict: true }) as LiveLine)
        .filter((line) => line.text?.trim() && typeof line.startRecordingMs === "number")
        .sort((a, b) => a.startRecordingMs! - b.startRecordingMs!);
}

function liveSpeaker(participants: Participant[], line: LiveLine): string {
    if (line.speaker?.name) {
        return line.speaker.name;
    }

    if (line.speaker?.source === "mic") {
        return participants.find((p) => p.isSelf)?.name ?? "Me";
    }

    return speakerLabel(participants, line.speaker?.id);
}

/**
 * The app sometimes stops refining a long meeting part-way (seen: refined ends at 13:18 of a 189 minute
 * recording) and never resumes. When the live lines run past the refined ones, the unrefined live
 * lines after the refined end are appended, and the gap is reported instead of truncating silently.
 */
export function completeTranscript(
    refined: TranscriptEntry[],
    live: LiveLine[],
    participants: Participant[]
): { transcript: TranscriptEntry[]; gap?: TranscriptGap } {
    const refinedUntilSec = Math.max(0, ...refined.map((e) => e.startSec ?? 0));
    const liveUntilSec = Math.max(0, ...live.map((l) => (l.endRecordingMs ?? l.startRecordingMs ?? 0) / 1000));

    if (liveUntilSec - refinedUntilSec <= GAP_TOLERANCE_SEC) {
        return { transcript: refined };
    }

    const tail = live
        .filter((line) => line.startRecordingMs! / 1000 > refinedUntilSec)
        .map<TranscriptEntry>((line) => ({
            id: line.id,
            startSec: Math.floor(line.startRecordingMs! / 1000),
            speakerId: line.speaker?.id,
            speaker: liveSpeaker(participants, line),
            text: line.text!.trim(),
        }));

    return {
        transcript: [...refined, ...tail],
        gap: { refinedUntilSec, liveUntilSec: Math.floor(liveUntilSec), appendedLines: tail.length },
    };
}
