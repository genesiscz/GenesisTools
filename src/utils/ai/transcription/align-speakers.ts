import type { TranscriptionSegment } from "@app/utils/ai/types";
import { normalizeSpeakerLabel } from "./speaker-label";

export interface DiarTurn {
    start: number;
    end: number;
    speaker: string;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * whisperX `assign_word_speakers`, segment granularity, `fillNearest=true`.
 * Each segment gets the speaker whose diarization turns overlap it most (sum
 * of overlaps, not first match); a segment with zero overlap is filled with
 * the temporally nearest turn so every cue is labelled (the reference SRTs
 * label every cue — leaving some blank would falsely punish the metric).
 */
export function assignSpeakers(segments: TranscriptionSegment[], turns: DiarTurn[]): TranscriptionSegment[] {
    return segments.map((seg) => {
        const byspk = new Map<string, number>();

        for (const t of turns) {
            const ov = overlap(seg.start, seg.end, t.start, t.end);

            if (ov > 0) {
                byspk.set(t.speaker, (byspk.get(t.speaker) ?? 0) + ov);
            }
        }

        let speaker: string | undefined;
        let best = 0;

        for (const [s, v] of byspk) {
            if (v > best) {
                best = v;
                speaker = s;
            }
        }

        if (!speaker && turns.length > 0) {
            const mid = (seg.start + seg.end) / 2;
            speaker = turns.reduce((p, c) =>
                Math.abs((c.start + c.end) / 2 - mid) < Math.abs((p.start + p.end) / 2 - mid) ? c : p,
            ).speaker;
        }

        return { ...seg, speaker: normalizeSpeakerLabel(speaker) };
    });
}
