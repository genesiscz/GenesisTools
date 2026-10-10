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

/** A live line counts as already refined when this share of its words appears, in order, in the last refined entry. */
const REFINED_OVERLAP = 0.6;

/**
 * The last refined entry is spoken at no fewer than this many words per second, plus the slack below, so a
 * live line that starts later than that is new speech however many words it shares with the entry.
 */
const SLOWEST_WORDS_PER_SEC = 2;
const REFINED_SPAN_SLACK_SEC = 10;

/**
 * The `timestamp` strings in `live.ndjson` run on different clocks per audio source (mic vs system),
 * so lines are placed by `startRecordingMs`, which both sources share.
 * The app appends to the file while the meeting runs, so an unfinished last line (no newline after it)
 * is skipped; a broken line anywhere else throws.
 */
export function parseLive(raw: string): LiveLine[] {
    const rows = raw.split("\n").filter((row) => row.trim());
    const lines: LiveLine[] = [];

    for (const [index, row] of rows.entries()) {
        try {
            lines.push(SafeJSON.parse(row, { strict: true }) as LiveLine);
        } catch (err) {
            if (index === rows.length - 1 && !raw.endsWith("\n")) {
                continue;
            }

            throw err;
        }
    }

    return lines
        .filter((line) => line.text?.trim() && typeof line.startRecordingMs === "number")
        .sort((a, b) => a.startRecordingMs! - b.startRecordingMs!);
}

/** The current assignment (a manual rename included) wins over the name the live line captured. */
function liveSpeaker(participants: Participant[], line: LiveLine): string {
    if (line.speaker?.source === "mic") {
        return participants.find((p) => p.isSelf)?.name ?? "Me";
    }

    if (participants.some((p) => p.speakerId === line.speaker?.id)) {
        return speakerLabel(participants, line.speaker?.id);
    }

    return line.speaker?.name || speakerLabel(participants, line.speaker?.id);
}

function words(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}

/** Length of the longest common subsequence: the words both share in the same order. */
function sharedInOrder(a: string[], b: string[]): number {
    let previous = new Array<number>(b.length + 1).fill(0);

    for (const word of a) {
        const current = new Array<number>(b.length + 1).fill(0);

        for (const [index, other] of b.entries()) {
            current[index + 1] = word === other ? previous[index] + 1 : Math.max(previous[index + 1], current[index]);
        }

        previous = current;
    }

    return previous[b.length];
}

function repeatsRefined(line: LiveLine, refinedWords: string[], refinedEndSec: number): boolean {
    const own = words(line.text ?? "");

    if (own.length === 0 || line.startRecordingMs! / 1000 > refinedEndSec) {
        return false;
    }

    return sharedInOrder(own, refinedWords) / own.length >= REFINED_OVERLAP;
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
    const liveUntilSec = Math.max(0, ...live.map((l) => (l.endRecordingMs ?? l.startRecordingMs ?? 0) / 1000));
    const lastRefined = refined.reduce<TranscriptEntry | undefined>(
        (latest, entry) => (latest && (latest.startSec ?? 0) >= (entry.startSec ?? 0) ? latest : entry),
        undefined
    );
    const lastStartSec = lastRefined?.startSec ?? 0;
    const after = live.filter((line) => !lastRefined || line.startRecordingMs! / 1000 > lastStartSec);
    // Refined lines carry only a start, so the speech of the last one runs on into live lines that start
    // after it. Those repeat its words; they are skipped, and where they end is where the refined text ends.
    const refinedWords = words(lastRefined?.text ?? "");
    const latestRefinedEndSec = lastStartSec + refinedWords.length / SLOWEST_WORDS_PER_SEC + REFINED_SPAN_SLACK_SEC;
    let repeated = 0;

    while (repeated < after.length && repeatsRefined(after[repeated], refinedWords, latestRefinedEndSec)) {
        repeated++;
    }

    const lastRepeated = after[repeated - 1];
    const refinedUntilSec = lastRepeated
        ? Math.floor((lastRepeated.endRecordingMs ?? lastRepeated.startRecordingMs!) / 1000)
        : lastStartSec;

    if (lastRefined && liveUntilSec - refinedUntilSec <= GAP_TOLERANCE_SEC) {
        return { transcript: refined };
    }

    const tail = after.slice(repeated).map<TranscriptEntry>((line) => ({
        id: line.id,
        startSec: Math.floor(line.startRecordingMs! / 1000),
        speakerId: line.speaker?.id,
        speaker: liveSpeaker(participants, line),
        text: line.text!.trim(),
    }));

    if (tail.length === 0) {
        return { transcript: refined };
    }

    return {
        transcript: [...refined, ...tail],
        gap: { refinedUntilSec, liveUntilSec: Math.floor(liveUntilSec), appendedLines: tail.length },
    };
}
