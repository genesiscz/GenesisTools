import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import type { DiarTurn } from "@app/utils/ai/transcription/align-speakers";
import { convertToWhisperWav } from "@app/utils/audio/converter";
import { ensureDiarizationModels } from "@app/utils/audio/diarize-models";

interface SherpaWave {
    samples: Float32Array;
    sampleRate: number;
}

interface SherpaSegment {
    start: number;
    end: number;
    speaker: number;
}

interface SherpaDiarizer {
    sampleRate: number;
    process(samples: Float32Array): SherpaSegment[];
}

interface SherpaModule {
    readWave(path: string): SherpaWave;
    OfflineSpeakerDiarization: new (config: {
        segmentation: { pyannote: { model: string } };
        embedding: { model: string };
        clustering: { numClusters: number; threshold: number };
        minDurationOn: number;
        minDurationOff: number;
    }) => SherpaDiarizer;
}

/**
 * Diarize an audio buffer locally (sherpa-onnx, pyannote-segmentation-3.0 +
 * WeSpeaker embedding) — no Python, no cloud. Returns `[]` (never throws) when
 * the native addon or models are unavailable, so the caller degrades to a
 * transcript without speakers instead of failing. sherpa emits integer
 * speaker ids; `assignSpeakers` → `normalizeSpeakerLabel` turns them into the
 * `SPEAKER_NN` convention.
 */
export async function diarizeLocal(audio: Buffer, opts?: { speakers?: number }): Promise<DiarTurn[]> {
    const wavPath = join(tmpdir(), `diar-${Date.now()}.wav`);

    try {
        const wav = await convertToWhisperWav(audio); // 16 kHz mono 16-bit
        await Bun.write(wavPath, wav);

        const { segmentation, embedding } = await ensureDiarizationModels();
        const sherpa = require("sherpa-onnx-node") as SherpaModule;

        // Default to 2 clusters when the caller doesn't specify. Pure
        // auto-detect (numClusters:-1) over-splits long Czech interview audio
        // badly (gth → 5 spurious speakers) because WeSpeaker embeddings drift
        // over a 14-min phone recording; raising the merge threshold instead
        // is fragile (over-merges short segments to 1). Interview/meeting
        // audio is overwhelmingly 2-party, so a fixed 2 is the robust default
        // and converges to the 2-speaker reference SRTs; `--speakers N`
        // overrides for N-party calls.
        const numClusters = opts?.speakers && opts.speakers > 0 ? opts.speakers : 2;
        const sd = new sherpa.OfflineSpeakerDiarization({
            segmentation: { pyannote: { model: segmentation } },
            embedding: { model: embedding },
            clustering: { numClusters, threshold: 0.5 },
            minDurationOn: 0.3,
            minDurationOff: 0.5,
        });

        const wave = sherpa.readWave(wavPath);

        if (sd.sampleRate !== wave.sampleRate) {
            throw new Error(`sherpa expects ${sd.sampleRate}Hz, got ${wave.sampleRate}Hz`);
        }

        return sd.process(wave.samples).map((s) => ({
            start: s.start,
            end: s.end,
            speaker: String(s.speaker),
        }));
    } catch (err) {
        logger.warn(`Local diarization unavailable, returning transcript without speakers: ${err}`);

        return [];
    } finally {
        try {
            unlinkSync(wavPath);
        } catch {
            /* temp file may not exist if conversion failed */
        }
    }
}
