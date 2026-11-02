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
/** Speech under the same label this long after a leave phrase is someone else (or the person came back). */
const LEAVE_CONTINUES_AFTER_SEC = 30;
/** A cut-off line and the next one count as one sentence when the next starts within this many seconds. */
const JOIN_WITHIN_SEC = 1.5;

/** A pattern that matches only as whole words. JavaScript's `\b` treats "í" or "ž" as a word edge, so it cannot. */
function wholeWords(pattern: string): RegExp {
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * Phrases a person says when they leave the call. Czech and English, matched case-insensitively anywhere in a line.
 * A label that keeps speaking after one of them holds more than one voice (rules R1 and R5 of the meetings skill).
 */
export const LEAVE_PHRASES: readonly RegExp[] = [
    "mějte se",
    "mizím",
    "(?:já )?už musím",
    "musím (?:jít|běžet|letět|končit|se odpojit)",
    "budu muset (?:jít|končit|běžet)",
    "měla? .{0,30}jít",
    "(?:já )?končím",
    "loučím se",
    "na shledanou",
    "bye|goodbye|see you",
    "(?:i have to|i need to|gotta) (?:go|drop|leave|run)",
].map(wholeWords);

/** Who named a label: the meeting platform (evidence), a language model (a guess), the user, or nobody known. */
export type SpeakerOrigin = "platform" | "llm" | "self" | "unknown";

export interface SpeakerSpan {
    fromSec: number;
    toSec: number;
    turns: number;
}

/** A leave phrase under a label, and when the same label speaks again. */
export interface SpeakerLeave {
    atSec: number;
    text: string;
    continuesAtSec: number;
}

export interface SpeakerStat {
    label: string;
    speakerId?: number;
    origin: SpeakerOrigin;
    turns: number;
    lines: number;
    words: number;
    /** Estimated seconds of speech; 0 when the transcript has no times. */
    spokenSec: number;
    firstSec?: number;
    lastSec?: number;
    spans: SpeakerSpan[];
    /** Leave phrases followed by more speech under this label: a boundary between two voices. */
    leaves: SpeakerLeave[];
}

/**
 * How much a hint is worth (rule R0): a label the platform named is evidence, so a hint against it is weak; a label a
 * language model guessed is a hypothesis, so a hint against it is strong.
 */
export type HintStrength = "weak" | "normal" | "strong";

/** Two lines that are one sentence cut by diarization: the last word of one and the first word of the next. */
export interface SplitJoin {
    atSec: number;
    left: string;
    right: string;
    joined: string;
}

export type SpeakerHint =
    | { kind: "several-people"; label: string; strength: HintStrength; spans: number; share: number }
    | { kind: "leave-then-continues"; label: string; strength: HintStrength; leaves: SpeakerLeave[] }
    | {
          kind: "split-voice";
          label: string;
          strength: HintStrength;
          neighbour: string;
          turns: number;
          spokenSec: number;
          atSec?: number;
          join?: SplitJoin;
      };

export interface SpeakerStats {
    /** False when no line has a time: then only counts are known. */
    timed: boolean;
    speakers: SpeakerStat[];
    hints: SpeakerHint[];
}

function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
}

function originOf(origin: string | undefined, isSelf: boolean | undefined): SpeakerOrigin {
    if (isSelf || origin === "self") {
        return "self";
    }

    return origin === "platform" || origin === "llm" ? origin : "unknown";
}

function strengthFor(origin: SpeakerOrigin): HintStrength {
    if (origin === "llm") {
        return "strong";
    }

    return origin === "platform" || origin === "self" ? "weak" : "normal";
}

/** The word cut between two lines: the first ends without punctuation, the next starts in lower case. */
function splitJoin(
    first: TranscriptEntry,
    firstEnd: number | undefined,
    next: TranscriptEntry | undefined
): SplitJoin | undefined {
    if (!next || firstEnd === undefined || next.startSec === undefined || next.startSec - firstEnd > JOIN_WITHIN_SEC) {
        return undefined;
    }

    const left = first.text.trim().split(/\s+/).at(-1) ?? "";
    const right = next.text.trim().split(/\s+/)[0] ?? "";

    if (!left || !right || /[.!?…,;:]$/.test(left) || !/^\p{Ll}/u.test(right)) {
        return undefined;
    }

    const cleanRight = right.replace(/[.!?…,;:]+$/, "");
    return { atSec: next.startSec, left, right: cleanRight, joined: `${left}${cleanRight}` };
}

interface TurnRun {
    label: string;
    lines: number[];
    fromSec?: number;
    toSec?: number;
}

/**
 * Per label: turns, lines, words, estimated speech, the spans the label speaks in, and the leave phrases it keeps
 * talking after. The hints point a person at what to check: a label that is probably several people, a label that
 * speaks on after saying goodbye, and a lone one-turn label that is probably a voice cut off from its neighbour.
 * `participants` give each label its origin (who named it), which sets how strong a hint is.
 */
export function speakerStats(
    entries: TranscriptEntry[],
    options: { gapSec?: number; participants?: Participant[] } = {}
): SpeakerStats {
    const gapSec = options.gapSec ?? DEFAULT_SPAN_GAP_SEC;
    const participants = options.participants ?? [];
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
    const endOf = (index: number): number | undefined => {
        const start = lines[index]?.startSec;
        return start === undefined ? undefined : start + spoken[index]!;
    };

    const runs: TurnRun[] = [];

    lines.forEach((entry, index) => {
        const run = runs.at(-1);

        if (!run || run.label !== entry.speaker) {
            runs.push({ label: entry.speaker, lines: [index], fromSec: entry.startSec, toSec: endOf(index) });
            return;
        }

        run.lines.push(index);
        run.fromSec ??= entry.startSec;
        run.toSec = endOf(index) ?? run.toSec;
    });

    const byLabel = new Map<string, SpeakerStat>();

    lines.forEach((entry, index) => {
        let stat = byLabel.get(entry.speaker);

        if (!stat) {
            const person = participants.find((p) => p.speakerId !== undefined && p.speakerId === entry.speakerId);
            stat = {
                label: entry.speaker,
                speakerId: entry.speakerId,
                origin: originOf(person?.origin, person?.isSelf),
                turns: 0,
                lines: 0,
                words: 0,
                spokenSec: 0,
                spans: [],
                leaves: [],
            };
            byLabel.set(entry.speaker, stat);
        }

        stat.lines += 1;
        stat.words += wordCount(entry.text);
        stat.spokenSec += spoken[index]!;

        if (entry.startSec !== undefined) {
            stat.firstSec ??= entry.startSec;
            stat.lastSec = endOf(index);
        }

        if (entry.startSec === undefined || !LEAVE_PHRASES.some((phrase) => phrase.test(entry.text))) {
            return;
        }

        const leftAt = entry.startSec;
        const later = lines.find(
            (other, otherIndex) =>
                otherIndex > index &&
                other.speaker === entry.speaker &&
                other.startSec !== undefined &&
                other.startSec - leftAt >= LEAVE_CONTINUES_AFTER_SEC
        );

        if (later?.startSec !== undefined) {
            stat.leaves.push({ atSec: leftAt, text: entry.text.trim(), continuesAtSec: later.startSec });
        }
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

    for (const stat of speakers) {
        const strength = strengthFor(stat.origin);

        if (stat.leaves.length > 0) {
            hints.push({ kind: "leave-then-continues", label: stat.label, strength, leaves: stat.leaves });
        }

        const share = totalSpoken > 0 ? stat.spokenSec / totalSpoken : 0;

        if (timed && stat.spans.length >= 2 && share >= SEVERAL_MIN_SHARE) {
            hints.push({ kind: "several-people", label: stat.label, strength, spans: stat.spans.length, share });
        }
    }

    for (const stat of speakers) {
        if (speakers.length < 2 || stat.turns > LONE_MAX_TURNS || (timed && stat.spokenSec > LONE_MAX_SEC)) {
            continue;
        }

        const runIndex = runs.findIndex((run) => run.label === stat.label);
        const run = runs[runIndex]!;
        const nextRun = runs[runIndex + 1];
        const neighbour = nextRun?.label ?? runs[runIndex - 1]?.label;

        if (!neighbour) {
            continue;
        }

        const lastLine = run.lines.at(-1)!;
        const join = nextRun ? splitJoin(lines[lastLine]!, endOf(lastLine), lines[nextRun.lines[0]!]) : undefined;
        hints.push({
            kind: "split-voice",
            label: stat.label,
            strength: join ? "strong" : "normal",
            neighbour,
            turns: stat.turns,
            spokenSec: stat.spokenSec,
            atSec: stat.firstSec,
            ...(join ? { join } : {}),
        });
    }

    return { timed, speakers, hints };
}
