import type { Transcript, TranscriptSegment } from "@app/youtube/lib/types";

/**
 * YouTube auto-captions are noisy: overlapping sliding windows, sub-sentence fragments,
 * caption annotations like [music] / [applause]. `compactTranscript` cleans the segment
 * stream so downstream LLM calls see roughly half the bytes with zero quality loss.
 *
 * All transformations are pure — the input transcript is not mutated.
 */
export interface CompactOptions {
    /** Strip pure-noise segments and inline `[music]/[applause]/…` annotations. Default true. */
    stripNoise?: boolean;
    /** Drop segments whose text is a substring of the previous (kept) segment. Default true. */
    dedupeOverlaps?: boolean;
    /** Merge consecutive segments at sentence boundaries (`. ! ?`). Default false (opt-in). */
    mergeSentences?: boolean;
    /**
     * If set, the final pass merges segments into fixed-length time buckets, ignoring
     * sentence boundaries. Use this for very long videos where you only need roughly
     * accurate timestamps per N seconds. Mutually exclusive with `mergeSentences`.
     */
    bucketSec?: number;
}

const NOISE_TAGS = new Set([
    "music",
    "applause",
    "laughter",
    "noise",
    "inaudible",
    "silence",
    "background music",
    "background noise",
    "cheering",
]);

const BRACKET_TAG = /\[\s*([^\]]+?)\s*\]/g;
const NOISE_ONLY = /^\s*(?:\[\s*[^\]]+\s*\]\s*)+\s*$/;

export function isNoiseSegment(text: string): boolean {
    if (!NOISE_ONLY.test(text)) {
        return false;
    }

    const tags = Array.from(text.matchAll(BRACKET_TAG)).map((match) => match[1].toLowerCase().trim());
    return tags.length > 0 && tags.every((tag) => NOISE_TAGS.has(tag));
}

function stripInlineNoise(text: string): string {
    return text
        .replace(BRACKET_TAG, (_full, raw: string) => (NOISE_TAGS.has(raw.toLowerCase().trim()) ? "" : `[${raw}]`))
        .replace(/\s+/g, " ")
        .trim();
}

function passStripNoise(segments: TranscriptSegment[]): TranscriptSegment[] {
    const out: TranscriptSegment[] = [];

    for (const segment of segments) {
        if (isNoiseSegment(segment.text)) {
            continue;
        }

        const cleaned = stripInlineNoise(segment.text);

        if (cleaned.length === 0) {
            continue;
        }

        out.push({ ...segment, text: cleaned });
    }

    return out;
}

function passDedupeOverlaps(segments: TranscriptSegment[]): TranscriptSegment[] {
    const out: TranscriptSegment[] = [];

    for (const segment of segments) {
        const prev = out.at(-1);

        if (!prev) {
            out.push(segment);
            continue;
        }

        if (prev.text.toLowerCase().includes(segment.text.toLowerCase())) {
            continue;
        }

        if (segment.text.toLowerCase().includes(prev.text.toLowerCase())) {
            out[out.length - 1] = segment;
            continue;
        }

        out.push(segment);
    }

    return out;
}

function passMergeSentences(segments: TranscriptSegment[]): TranscriptSegment[] {
    const out: TranscriptSegment[] = [];
    let buffer: TranscriptSegment | null = null;

    for (const segment of segments) {
        if (!buffer) {
            buffer = { ...segment };
            continue;
        }

        buffer = {
            text: `${buffer.text} ${segment.text}`.replace(/\s+/g, " "),
            start: buffer.start,
            end: segment.end,
        };

        if (/[.!?]\s*$/.test(buffer.text)) {
            out.push(buffer);
            buffer = null;
        }
    }

    if (buffer) {
        out.push(buffer);
    }

    return out;
}

function passBucket(segments: TranscriptSegment[], bucketSec: number): TranscriptSegment[] {
    if (bucketSec <= 0) {
        return segments;
    }

    const out: TranscriptSegment[] = [];
    let buffer: TranscriptSegment | null = null;

    for (const segment of segments) {
        if (!buffer) {
            buffer = { ...segment };
            continue;
        }

        if (segment.end - buffer.start <= bucketSec) {
            buffer = {
                text: `${buffer.text} ${segment.text}`.replace(/\s+/g, " "),
                start: buffer.start,
                end: segment.end,
            };
            continue;
        }

        out.push(buffer);
        buffer = { ...segment };
    }

    if (buffer) {
        out.push(buffer);
    }

    return out;
}

export function compactTranscript(transcript: Transcript, opts: CompactOptions = {}): Transcript {
    const stripNoise = opts.stripNoise !== false;
    const dedupeOverlaps = opts.dedupeOverlaps !== false;
    const mergeSentences = opts.mergeSentences === true && opts.bucketSec === undefined;

    let segments = transcript.segments;

    if (stripNoise) {
        segments = passStripNoise(segments);
    }

    if (dedupeOverlaps) {
        segments = passDedupeOverlaps(segments);
    }

    if (opts.bucketSec !== undefined) {
        segments = passBucket(segments, opts.bucketSec);
    } else if (mergeSentences) {
        segments = passMergeSentences(segments);
    }

    return {
        ...transcript,
        segments,
        text: segments.map((segment) => segment.text).join(" "),
    };
}
