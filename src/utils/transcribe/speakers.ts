import type { Participant, TranscriptEntry } from "./types";

export function speakerLabel(participants: Participant[], speakerId: number | undefined): string {
    const named = participants.find((p) => p.speakerId === speakerId);

    if (named) {
        return named.name;
    }

    return speakerId === undefined ? "Unknown" : `Speaker ${speakerId}`;
}

export function firstName(name: string): string {
    return name.split(/\s+/)[0] ?? name;
}

/** A pause shorter than this between two turns of one label keeps them in one span. */
export const DEFAULT_SPAN_GAP_SEC = 120;
/** Spoken time of a line is the time to the next line, but no more than this per word (a silence is not speech). */
const MAX_SEC_PER_WORD = 0.8;
/** A line with no next line, or no time, counts this much per word. */
const SEC_PER_WORD = 0.4;
/** A label with this many turns at most and this much speech, next to another label, may be a split voice. */
const LONE_MAX_TURNS = 1;
const LONE_MAX_SEC = 10;
/** A label with several spans and at least this share of the speech may be several people. */
const SEVERAL_MIN_SHARE = 0.25;

export interface SpeakerSpan {
    fromSec: number;
    toSec: number;
    turns: number;
}

export interface SpeakerStat {
    label: string;
    speakerId?: number;
    turns: number;
    lines: number;
    words: number;
    /** Estimated seconds of speech; 0 when the transcript has no times. */
    spokenSec: number;
    firstSec?: number;
    lastSec?: number;
    spans: SpeakerSpan[];
}

export type SpeakerHint =
    | { kind: "several-people"; label: string; spans: number; share: number }
    | { kind: "split-voice"; label: string; neighbour: string; turns: number; spokenSec: number; atSec?: number };

export interface SpeakerStats {
    /** False when no line has a time: then only counts are known. */
    timed: boolean;
    speakers: SpeakerStat[];
    hints: SpeakerHint[];
}

function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
}

interface TurnRun {
    label: string;
    speakerId?: number;
    lines: TranscriptEntry[];
    fromSec?: number;
    toSec?: number;
}

/**
 * Per label: turns, lines, words, estimated speech and the spans the label speaks in, plus two hints for a
 * person to check: one label that is probably several people, and a short lone label that is probably one voice
 * cut off from its neighbour.
 */
export function speakerStats(entries: TranscriptEntry[], options: { gapSec?: number } = {}): SpeakerStats {
    const gapSec = options.gapSec ?? DEFAULT_SPAN_GAP_SEC;
    const lines = entries.filter((entry) => entry.text.trim());
    const timed = lines.some((entry) => entry.startSec !== undefined);
    const spoken = lines.map((entry, index) => {
        const words = wordCount(entry.text);
        const next = lines[index + 1]?.startSec;

        if (entry.startSec === undefined || !timed) {
            return 0;
        }

        if (next === undefined || next <= entry.startSec) {
            return words * SEC_PER_WORD;
        }

        return Math.min(next - entry.startSec, words * MAX_SEC_PER_WORD);
    });

    const runs: TurnRun[] = [];

    lines.forEach((entry, index) => {
        const run = runs.at(-1);
        const end = entry.startSec === undefined ? undefined : entry.startSec + spoken[index]!;

        if (!run || run.label !== entry.speaker) {
            runs.push({
                label: entry.speaker,
                speakerId: entry.speakerId,
                lines: [entry],
                fromSec: entry.startSec,
                toSec: end,
            });
            return;
        }

        run.lines.push(entry);
        run.fromSec ??= entry.startSec;
        run.toSec = end ?? run.toSec;
    });

    const byLabel = new Map<string, SpeakerStat>();

    lines.forEach((entry, index) => {
        const stat = byLabel.get(entry.speaker) ?? {
            label: entry.speaker,
            speakerId: entry.speakerId,
            turns: 0,
            lines: 0,
            words: 0,
            spokenSec: 0,
            spans: [],
        };
        stat.lines += 1;
        stat.words += wordCount(entry.text);
        stat.spokenSec += spoken[index]!;

        if (entry.startSec !== undefined) {
            stat.firstSec ??= entry.startSec;
            stat.lastSec = entry.startSec + spoken[index]!;
        }

        byLabel.set(entry.speaker, stat);
    });

    for (const run of runs) {
        const stat = byLabel.get(run.label)!;
        stat.turns += 1;

        if (run.fromSec === undefined || run.toSec === undefined) {
            continue;
        }

        const span = stat.spans.at(-1);

        if (span && run.fromSec - span.toSec < gapSec) {
            span.toSec = run.toSec;
            span.turns += 1;
        } else {
            stat.spans.push({ fromSec: run.fromSec, toSec: run.toSec, turns: 1 });
        }
    }

    const speakers = [...byLabel.values()];
    const totalSpoken = speakers.reduce((sum, stat) => sum + stat.spokenSec, 0);
    const hints: SpeakerHint[] = [];

    if (timed && totalSpoken > 0) {
        for (const stat of speakers) {
            const share = stat.spokenSec / totalSpoken;

            if (stat.spans.length >= 2 && share >= SEVERAL_MIN_SHARE) {
                hints.push({ kind: "several-people", label: stat.label, spans: stat.spans.length, share });
            }
        }
    }

    for (const stat of speakers) {
        if (stat.turns > LONE_MAX_TURNS || (timed && stat.spokenSec > LONE_MAX_SEC)) {
            continue;
        }

        const index = runs.findIndex((run) => run.label === stat.label);
        const neighbour = runs[index + 1]?.label ?? runs[index - 1]?.label;

        if (!neighbour || neighbour === stat.label || speakers.length < 2) {
            continue;
        }

        hints.push({
            kind: "split-voice",
            label: stat.label,
            neighbour,
            turns: stat.turns,
            spokenSec: stat.spokenSec,
            atSec: stat.firstSec,
        });
    }

    return { timed, speakers, hints };
}
