import { z } from "zod";

/**
 * Cutting a movie by its transcript: words of a line, or every filler word ("ehm", "um"). A transcript line has a
 * start and an end; a provider that times words (`segments[].words`) gives each word its own time, and without one a
 * word's time is estimated from where its letters sit in the line (`estimated: true`), which is close for steady
 * speech and off by a few hundred ms for a pause inside the line.
 */

/**
 * The filler words per spoken language, in two levels: `sounds` are never words ("ehm"), `words` are fillers that are
 * also real words ("jako" is "as" in "stejně jako"), so cutting them is a choice. A caller passes its own list instead.
 * Measured on a 54-minute Czech meeting (2026-11-04): 24 sounds and 199 "jako"/"jakože".
 */
export type FillerLists = Record<string, { sounds: readonly string[]; words: readonly string[] }>;

/** The shipped lists. The meetings config (`languages.<code>.fillers`) starts from them and may replace each. */
export const FILLER_WORDS: FillerLists = {
    cs: { sounds: ["ehm", "hm", "hmm", "eh", "em", "ee", "éé", "mhm"], words: ["jako", "jakože"] },
    sk: { sounds: ["ehm", "hm", "hmm", "eh", "em", "ee", "éé", "mhm"], words: ["akože", "jako"] },
    en: { sounds: ["um", "uh", "uhm", "erm", "er", "hmm", "hm", "mhm"], words: ["like"] },
};

/** `sounds` (default) cuts only the non-words; `all` also the filler words. */
export const FILLER_LEVELS = ["sounds", "all"] as const;
export type FillerLevel = (typeof FILLER_LEVELS)[number];

const wordSchema = z
    .object({ start: z.number(), end: z.number() })
    .and(z.union([z.object({ word: z.string() }), z.object({ text: z.string() })]));

export const transcriptSegmentSchema = z.object({
    text: z.string(),
    start: z.number(),
    end: z.number(),
    words: z.array(wordSchema).optional(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptFileSchema = z.object({ segments: z.array(transcriptSegmentSchema).default([]) });

export interface WordSpan {
    word: string;
    /** Source seconds. */
    start: number;
    end: number;
    estimated: boolean;
}

/** A word as the lists compare it: lowercase, without the punctuation around it. */
export function foldWord(word: string): string {
    return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** The words of one line with their times. */
export function wordSpans(segment: TranscriptSegment): WordSpan[] {
    if (segment.words && segment.words.length > 0) {
        return segment.words.map((word) => ({
            word: "word" in word ? word.word : word.text,
            start: word.start,
            end: word.end,
            estimated: false,
        }));
    }

    const spans: WordSpan[] = [];
    const length = Math.max(1, segment.text.length);
    const seconds = segment.end - segment.start;

    for (const match of segment.text.matchAll(/\S+/g)) {
        const from = match.index ?? 0;
        spans.push({
            word: match[0],
            start: segment.start + (seconds * from) / length,
            end: segment.start + (seconds * (from + match[0].length)) / length,
            estimated: true,
        });
    }

    return spans;
}

export interface CutMatch {
    /** What is cut, as it reads in the line. */
    text: string;
    fromUs: number;
    toUs: number;
    /** The line the words are in, by its source start in seconds. */
    line: number;
    estimated: boolean;
}

function toMatch(spans: WordSpan[], segment: TranscriptSegment, padSec: number): CutMatch {
    const from = Math.max(segment.start, spans[0].start - padSec);
    const to = Math.min(segment.end, (spans.at(-1) as WordSpan).end + padSec);
    return {
        text: spans.map((span) => span.word).join(" "),
        fromUs: Math.round(from * 1_000_000),
        toUs: Math.round(to * 1_000_000),
        line: segment.start,
        estimated: spans.some((span) => span.estimated),
    };
}

/** The line spoken at `atSec` (or the nearest one that starts within 1 s of it). */
export function lineAt(segments: readonly TranscriptSegment[], atSec: number): TranscriptSegment | undefined {
    return (
        segments.find((segment) => segment.start <= atSec + 0.0005 && atSec < segment.end) ??
        segments.find((segment) => Math.abs(segment.start - atSec) <= 1)
    );
}

/**
 * Where `words` (one or more words, in order) are said in the line at `atSec`: every place they occur, or with
 * `occurrence` only that one (1 is the first place in the line), as the editor cuts the words picked in a line.
 */
export function wordCuts(options: {
    segments: readonly TranscriptSegment[];
    atSec: number;
    words: string;
    occurrence?: number;
    padMs?: number;
}): CutMatch[] {
    const segment = lineAt(options.segments, options.atSec);

    if (!segment) {
        throw new RangeError(`nobody speaks at ${options.atSec} s; transcript() lists the lines`);
    }

    const wanted = options.words.split(/\s+/).map(foldWord).filter(Boolean);

    if (wanted.length === 0) {
        throw new RangeError("give the words to cut");
    }

    const spans = wordSpans(segment);
    const matches: CutMatch[] = [];

    for (let index = 0; index + wanted.length <= spans.length; index++) {
        const run = spans.slice(index, index + wanted.length);

        if (run.every((span, at) => foldWord(span.word) === wanted[at])) {
            matches.push(toMatch(run, segment, (options.padMs ?? 40) / 1000));
        }
    }

    if (matches.length === 0) {
        throw new RangeError(
            `the line at ${segment.start} s ("${segment.text.trim()}") does not say "${options.words}"`
        );
    }

    if (options.occurrence === undefined) {
        return matches;
    }

    const picked = matches[options.occurrence - 1];

    if (!picked) {
        throw new RangeError(
            `the line at ${segment.start} s says "${options.words}" ${matches.length === 1 ? "once" : `${matches.length} times`}, so there is no place ${options.occurrence}`
        );
    }

    return [picked];
}

/**
 * The filler words to cut: your own `words`, else `language`'s list (absent: every language's) at `level`. `lists`
 * is where the lists come from: the shipped `FILLER_WORDS` unless the caller passes the config's.
 */
export function fillerList(options: {
    language?: string;
    words?: readonly string[];
    level?: FillerLevel;
    lists?: FillerLists;
}): string[] {
    if (options.words && options.words.length > 0) {
        return options.words.map(foldWord).filter(Boolean);
    }

    const level = options.level ?? "sounds";
    const lists = options.lists ?? FILLER_WORDS;
    const pick = (list: { sounds: readonly string[]; words: readonly string[] }) =>
        level === "all" ? [...list.sounds, ...list.words] : [...list.sounds];

    if (options.language !== undefined) {
        const list = lists[options.language];

        if (!list) {
            throw new RangeError(
                `no filler list for "${options.language}"; known: ${Object.keys(lists).join(", ")}, or pass words`
            );
        }

        return pick(list);
    }

    return [...new Set(Object.values(lists).flatMap(pick))];
}

/** Every filler word said in the transcript, each as its own cut (a run of fillers is one cut). */
export function fillerCuts(options: {
    segments: readonly TranscriptSegment[];
    fillers: readonly string[];
    padMs?: number;
}): CutMatch[] {
    const fillers = new Set(options.fillers.map(foldWord));
    const padSec = (options.padMs ?? 40) / 1000;
    const matches: CutMatch[] = [];

    for (const segment of options.segments) {
        let run: WordSpan[] = [];

        for (const span of [...wordSpans(segment), undefined]) {
            if (span && fillers.has(foldWord(span.word))) {
                run.push(span);
                continue;
            }

            if (run.length > 0) {
                matches.push(toMatch(run, segment, padSec));
                run = [];
            }
        }
    }

    return matches;
}

/** The cuts as source ranges, overlapping or touching ones joined, latest first (the order cuts apply in). */
export function cutRanges(cuts: readonly CutMatch[]): Array<{ fromUs: number; toUs: number }> {
    const merged: Array<{ fromUs: number; toUs: number }> = [];

    for (const cut of [...cuts].sort((a, b) => a.fromUs - b.fromUs)) {
        const last = merged.at(-1);

        if (last && cut.fromUs <= last.toUs) {
            last.toUs = Math.max(last.toUs, cut.toUs);
        } else {
            merged.push({ fromUs: cut.fromUs, toUs: cut.toUs });
        }
    }

    return merged.reverse();
}
