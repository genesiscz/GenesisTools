import { SafeJSON } from "@app/utils/json";
import { normalizeSpeakerLabel } from "./transcription/speaker-label";
import type { TranscriptionResult, TranscriptionSegment } from "./types";

export type OutputFormat = "text" | "json" | "srt" | "vtt";

export function formatTimestamp(seconds: number, separator: "," | "."): string {
    const totalMs = Math.round(seconds * 1000);
    const h = Math.floor(totalMs / 3_600_000);
    const m = Math.floor((totalMs % 3_600_000) / 60_000);
    const s = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;

    return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad3(ms)}`;
}

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

function pad3(n: number): string {
    return String(n).padStart(3, "0");
}

const MAX_CUE_SECONDS = 6;
const MAX_CUE_CHARS = 84;

/**
 * Group raw transcription segments into readable subtitle cues.
 *
 * Providers differ wildly in segment granularity: OpenAI Whisper returns
 * sentence-ish segments, Deepgram returns one segment *per word* (a 14-min
 * file → ~1250 one-word cues, useless as subtitles). Accumulate consecutive
 * segments into a cue, flushing on sentence-final punctuation or when the cue
 * would get too long/slow to read. Idempotent-ish for already-coarse input.
 */
function coalesceSegmentsForSubtitles(segments: TranscriptionSegment[]): TranscriptionSegment[] {
    const cues: TranscriptionSegment[] = [];
    let cur: TranscriptionSegment | undefined;

    for (const seg of segments) {
        const piece = seg.text.trim();

        if (!piece) {
            continue;
        }

        if (!cur) {
            cur = { text: piece, start: seg.start, end: seg.end, speaker: seg.speaker };
        } else {
            const merged = `${cur.text} ${piece}`;
            const tooLong = merged.length > MAX_CUE_CHARS;
            const tooSlow = seg.end - cur.start > MAX_CUE_SECONDS;
            const speakerChanged = cur.speaker !== seg.speaker;

            if (tooLong || tooSlow || speakerChanged) {
                cues.push(cur);
                cur = { text: piece, start: seg.start, end: seg.end, speaker: seg.speaker };
            } else {
                cur.text = merged;
                cur.end = seg.end;
            }
        }

        if (/[.!?…]["')\]]?$/.test(cur.text)) {
            cues.push(cur);
            cur = undefined;
        }
    }

    if (cur) {
        cues.push(cur);
    }

    return cues;
}

export function toSRT(result: TranscriptionResult): string {
    if (!result.segments?.length) {
        return result.text;
    }

    const cues = coalesceSegmentsForSubtitles(result.segments);

    if (cues.length === 0) {
        return result.text;
    }

    return cues
        .map((seg, i) => {
            const start = formatTimestamp(seg.start, ",");
            const end = formatTimestamp(seg.end, ",");
            const spk = normalizeSpeakerLabel(seg.speaker);
            const prefix = spk ? `${spk}: ` : "";
            return `${i + 1}\n${start} --> ${end}\n${prefix}${seg.text.trim()}`;
        })
        .join("\n\n");
}

export function toVTT(result: TranscriptionResult): string {
    if (!result.segments?.length) {
        return `WEBVTT\n\n${result.text}`;
    }

    const coalesced = coalesceSegmentsForSubtitles(result.segments);

    if (coalesced.length === 0) {
        return `WEBVTT\n\n${result.text}`;
    }

    const cues = coalesced
        .map((seg) => {
            const start = formatTimestamp(seg.start, ".");
            const end = formatTimestamp(seg.end, ".");
            const spk = normalizeSpeakerLabel(seg.speaker);
            const body = spk ? `<v ${spk}>${seg.text.trim()}` : seg.text.trim();
            return `${start} --> ${end}\n${body}`;
        })
        .join("\n\n");

    return `WEBVTT\n\n${cues}`;
}

/** Render speaker-grouped turns (`SPEAKER_NN: …`) when the transcript carries
 *  speaker labels; plain `result.text` otherwise. Consecutive same-speaker
 *  segments are merged into one turn line. */
function toSpeakerText(result: TranscriptionResult): string {
    const segs = result.segments;

    if (!segs?.length || !segs.some((s) => s.speaker)) {
        return result.text;
    }

    const lines: string[] = [];
    let curSpk: string | undefined;

    for (const seg of segs) {
        const piece = seg.text.trim();

        if (!piece) {
            continue;
        }

        const spk = normalizeSpeakerLabel(seg.speaker) ?? "SPEAKER_00";

        if (spk !== curSpk) {
            lines.push(`${spk}: ${piece}`);
            curSpk = spk;
        } else {
            lines[lines.length - 1] += ` ${piece}`;
        }
    }

    return lines.join("\n");
}

export function formatOutput(result: TranscriptionResult, format: OutputFormat): string {
    switch (format) {
        case "text":
            return toSpeakerText(result);
        case "json":
            return SafeJSON.stringify(result, null, 2);
        case "srt":
            return toSRT(result);
        case "vtt":
            return toVTT(result);
    }
}
