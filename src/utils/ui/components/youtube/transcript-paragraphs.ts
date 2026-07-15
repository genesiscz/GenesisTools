// Heuristic transcript → paragraph splitter. No ML.
//
// Rules, in priority order (see research doc
// Dev/AI/TranscriptParagraphSplitting.md for provenance):
//   (A) hard char cap                   → always flush
//   (B) hard silence gap                → always flush (if gaps are meaningful)
//   (C) sentence-end AND (soft gap OR target reached AND min length)
//   (D) fallback char cap when gaps are unusable (YouTube auto-captions)
// Orphan runs shorter than MIN_CHARS get absorbed into the previous paragraph.

import type { TranscriptSegment } from "@app/youtube/lib/types";

export interface TranscriptParagraph {
    text: string;
    start: number;
    end: number;
}

const SENTENCE_END_RE = /[.!?…。！？](["'’)\]]*)\s*$/;
const SENTENCE_CHAR_RE = /[.!?…。！？]/g;

const HARD_GAP = 1.5;
const SOFT_GAP = 0.65;
const TARGET_CHARS = 400;
const MAX_CHARS = 900;
const MIN_CHARS = 120;
const TARGET_SENTS = 3;
// Below this p95 gap the timing signal is dead (YouTube auto-captions have
// end[i] ≈ start[i+1]); we fall back to punctuation + char cap.
const GAP_SIGNAL_MIN_P95 = 0.25;

export function segmentsToParagraphs(segments: TranscriptSegment[]): TranscriptParagraph[] {
    if (segments.length === 0) {
        return [];
    }

    const gaps: number[] = [];
    for (let i = 1; i < segments.length; i++) {
        gaps.push(Math.max(0, segments[i].start - segments[i - 1].end));
    }
    const gapsSorted = [...gaps].sort((a, b) => a - b);
    const p95Gap = gapsSorted.length ? gapsSorted[Math.floor(gapsSorted.length * 0.95)] : 0;
    const gapsAreMeaningful = p95Gap >= GAP_SIGNAL_MIN_P95;

    const out: TranscriptParagraph[] = [];
    let buf = "";
    let bufStart = segments[0].start;
    let bufEnd = segments[0].start;
    let bufSentences = 0;

    function flush(): void {
        const trimmed = buf.trim();
        if (!trimmed) {
            return;
        }

        if (trimmed.length < MIN_CHARS && out.length > 0) {
            const prev = out[out.length - 1];
            prev.text = `${prev.text} ${trimmed}`;
            prev.end = bufEnd;
        } else {
            out.push({ text: trimmed, start: bufStart, end: bufEnd });
        }

        buf = "";
        bufSentences = 0;
    }

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const chunk = seg.text.trim();
        if (!chunk) {
            continue;
        }

        if (!buf) {
            buf = chunk;
            bufStart = seg.start;
            bufEnd = seg.end;
        } else {
            buf = `${buf} ${chunk}`;
            bufEnd = seg.end;
        }

        bufSentences += (chunk.match(SENTENCE_CHAR_RE) ?? []).length;

        const endsWithSentence = SENTENCE_END_RE.test(buf);
        const nextGap = i + 1 < segments.length ? Math.max(0, segments[i + 1].start - seg.end) : Infinity;

        if (buf.length >= MAX_CHARS) {
            flush();
            continue;
        }

        if (gapsAreMeaningful && nextGap >= HARD_GAP) {
            flush();
            continue;
        }

        if (endsWithSentence) {
            const reachedTarget = buf.length >= TARGET_CHARS || bufSentences >= TARGET_SENTS;
            const softPause = gapsAreMeaningful && nextGap >= SOFT_GAP;
            if (buf.length >= MIN_CHARS && (softPause || reachedTarget)) {
                flush();
                continue;
            }
        }

        if (!gapsAreMeaningful && buf.length >= TARGET_CHARS) {
            flush();
        }
    }

    flush();
    return out;
}
