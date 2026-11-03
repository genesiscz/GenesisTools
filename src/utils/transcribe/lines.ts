import type { TranscriptEntry } from "./types";

/** A line is "at" a time when it starts this close to it. Sources time lines in whole seconds. */
export const LINE_AT_TOLERANCE_SEC = 0.5;
/** The last timed line, with no line after it, is taken to last this long. */
export const LAST_LINE_SEC = 5;
/** A line lasts at least this long, also when the next one starts in the same second. */
export const MIN_LINE_SEC = 1;
/** A term clip starts this long before the spot its words are estimated at, and ends this long after it. */
export const SPOT_CLIP_SEC = { before: 1.5, after: 2.5 } as const;

/** Where a line is: its index in the source transcript and the second it starts at. */
export interface LineAddress {
    index: number;
    startSec: number;
}

/** The line a time or an address names: exactly one, none, or several that start in the same second. */
export type LineLookup = { kind: "found"; index: number } | { kind: "none" } | { kind: "ambiguous"; indexes: number[] };

/** One whole-word occurrence of heard words: the line, where they start in its text, and the text as written. */
export interface HeardOccurrence {
    index: number;
    at: number;
    text: string;
}

/** The words of a heard passage in its line, with the line before and after, each cut to about `maxChars`. */
export interface HeardContext {
    before?: string;
    /** The line's text up to the heard words, the heard words as the transcript has them, and the rest of the line. */
    lead: string;
    heard: string;
    rest: string;
    after?: string;
}

/** Heard words to look for, in the time range their lines start in. */
export interface HeardPassage {
    heard: string;
    fromSec: number;
    toSec: number;
}

/** The private-use characters the corrections put in as placeholders count as word characters at an edge. */
const WORD_EDGE = "\\p{L}\\p{N}\\uE000\\uE001";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word heard words: any case (Czech letters too), diacritics as written, any run of spaces between the words.
 * JavaScript's `\b` treats "í" or "ž" as a word edge, so the edges are spelled out: "Ada" never matches in "zadání".
 */
export function heardPattern(heard: string, flags: "iu" | "giu" = "giu"): RegExp {
    const words = escapeRegExp(heard.trim()).replace(/\s+/g, "\\s+");
    return new RegExp(`(?<![${WORD_EDGE}])${words}(?![${WORD_EDGE}])`, flags);
}

/** Where the heard words occur in a text, whole words only, in order. */
export function heardIn(text: string, heard: string): Array<{ at: number; text: string }> {
    if (!heard.trim()) {
        return [];
    }

    return [...text.matchAll(heardPattern(heard))].map((match) => ({ at: match.index, text: match[0] }));
}

/**
 * A source transcript as addressed lines: each line has an index, a start and an end (one rule, `end`). Built once
 * per transcript; the entries are not copied.
 */
export class TranscriptLines {
    private readonly ends: Array<number | undefined>;

    constructor(readonly entries: readonly TranscriptEntry[]) {
        this.ends = TranscriptLines.endsOf(entries);
    }

    /** One rule for every line: the next timed line's start, at least `MIN_LINE_SEC` on; the last line `LAST_LINE_SEC`. */
    private static endsOf(entries: readonly TranscriptEntry[]): Array<number | undefined> {
        const ends: Array<number | undefined> = entries.map(() => undefined);
        let next: number | undefined;

        for (let index = entries.length - 1; index >= 0; index--) {
            const entry = entries[index]!;

            if (entry.startSec === undefined || !entry.text.trim()) {
                continue;
            }

            ends[index] = Math.max(next ?? entry.startSec + LAST_LINE_SEC, entry.startSec + MIN_LINE_SEC);
            next = entry.startSec;
        }

        return ends;
    }

    address(index: number): LineAddress | undefined {
        const startSec = this.entries[index]?.startSec;
        return startSec === undefined ? undefined : { index, startSec };
    }

    /** When the line is spoken: from its start to its end. Lines with no time or no words have none. */
    span(index: number): { fromSec: number; toSec: number } | undefined {
        const fromSec = this.entries[index]?.startSec;
        const toSec = this.ends[index];
        return fromSec === undefined || toSec === undefined ? undefined : { fromSec, toSec };
    }

    /** Where the line ends: the next timed line's start, but at least `MIN_LINE_SEC` after its own start. */
    end(index: number): number | undefined {
        return this.ends[index];
    }

    /**
     * The line that starts at `sec` (within `LINE_AT_TOLERANCE_SEC`) and that `accept` takes. Two such lines are
     * reported as ambiguous, never guessed.
     */
    at(sec: number, accept: (entry: TranscriptEntry, index: number) => boolean = () => true): LineLookup {
        const indexes = this.entries.flatMap((entry, index) =>
            entry.startSec !== undefined &&
            Math.abs(entry.startSec - sec) <= LINE_AT_TOLERANCE_SEC &&
            entry.text.trim() &&
            accept(entry, index)
                ? [index]
                : []
        );

        if (indexes.length === 0) {
            return { kind: "none" };
        }

        return indexes.length === 1 ? { kind: "found", index: indexes[0]! } : { kind: "ambiguous", indexes };
    }

    /**
     * The line an anchor names: its address when the line there still starts at the anchor's time, else the line at
     * the time.
     */
    resolve(
        anchor: { atSec: number; line?: number },
        accept: (entry: TranscriptEntry, index: number) => boolean = () => true
    ): LineLookup {
        if (anchor.line !== undefined) {
            const entry = this.entries[anchor.line];
            const holds =
                entry?.startSec !== undefined &&
                Math.abs(entry.startSec - anchor.atSec) <= LINE_AT_TOLERANCE_SEC &&
                accept(entry, anchor.line);

            if (holds) {
                return { kind: "found", index: anchor.line };
            }
        }

        return this.at(anchor.atSec, accept);
    }

    /** Every whole-word occurrence of the passage's heard words in the lines that start in its range. */
    occurrences(passage: HeardPassage): HeardOccurrence[] {
        return this.entries.flatMap((entry, index) => {
            const startSec = entry.startSec;

            if (
                startSec === undefined ||
                startSec < passage.fromSec - LINE_AT_TOLERANCE_SEC ||
                startSec > passage.toSec + LINE_AT_TOLERANCE_SEC
            ) {
                return [];
            }

            return heardIn(entry.text, passage.heard).map((found) => ({ index, ...found }));
        });
    }

    /** The `n`-th (0-based) whole-word occurrence of the heard words in the range. */
    heardLine(passage: HeardPassage, n = 0): HeardOccurrence | undefined {
        return this.occurrences(passage)[n];
    }

    /** Where in the audio the occurrence is said, estimated from its place in its line's span. */
    spotSec(occurrence: HeardOccurrence): number | undefined {
        const span = this.span(occurrence.index);
        const text = this.entries[occurrence.index]?.text ?? "";

        if (!span) {
            return undefined;
        }

        return span.fromSec + (occurrence.at / Math.max(1, text.length)) * (span.toSec - span.fromSec);
    }

    /** The audio to play for an occurrence: from shortly before its spot to shortly after, so a late word is heard. */
    clip(occurrence: HeardOccurrence): { fromSec: number; toSec: number } | undefined {
        const spot = this.spotSec(occurrence);

        if (spot === undefined) {
            return undefined;
        }

        return { fromSec: Math.max(0, spot - SPOT_CLIP_SEC.before), toSec: spot + SPOT_CLIP_SEC.after };
    }

    /** The occurrence in its sentence, with the lines before and after, so two questions on one word differ. */
    context(occurrence: HeardOccurrence, maxChars: number): HeardContext {
        const text = this.entries[occurrence.index]!.text;
        const start = occurrence.at;
        const end = start + occurrence.text.length;
        const side = Math.max(20, Math.floor((maxChars - (end - start)) / 2));
        const lead = start > side ? `…${text.slice(start - side, start).replace(/^\S*\s/, "")}` : text.slice(0, start);
        const rest =
            text.length - end > side ? `${text.slice(end, end + side).replace(/\s\S*$/, "")}…` : text.slice(end);
        const neighbour = (step: -1 | 1): string | undefined => {
            const words = this.entries[occurrence.index + step]?.text.trim();

            if (!words) {
                return undefined;
            }

            if (words.length <= maxChars) {
                return words;
            }

            return step < 0
                ? `…${words.slice(-maxChars).replace(/^\S*\s/, "")}`
                : `${words.slice(0, maxChars).replace(/\s\S*$/, "")}…`;
        };
        const before = neighbour(-1);
        const after = neighbour(1);

        return {
            ...(before ? { before } : {}),
            lead,
            heard: occurrence.text,
            rest,
            ...(after ? { after } : {}),
        };
    }
}
