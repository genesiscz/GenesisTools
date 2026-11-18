import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireLazy = createRequire(import.meta.url);

export interface SpeakerStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
}

/** The part of sherpa-onnx's SpeakerEmbeddingExtractor the embedder uses; tests pass a fake. */
export interface SpeakerExtractor {
    createStream(): SpeakerStream;
    isReady(stream: SpeakerStream): boolean;
    compute(stream: SpeakerStream): Float32Array;
}

interface SherpaModule {
    SpeakerEmbeddingExtractor: new (config: {
        model: string;
        numThreads: number;
        provider: string;
        debug: boolean;
    }) => SpeakerExtractor;
}

/** The sample rate every speaker embedding reads. */
export const SPEAKER_EMBEDDING_RATE = 16000;

/** One clip's result: a vector, or why the clip cannot have one by its nature (quiet, too little speech). */
export type SpeakerEmbeddingResult = { embedding: number[] } | { unavailable: string };

/**
 * A local speaker-embedding model (sherpa-onnx). `model` names the model file by its content, so an embedding made
 * with another file never compares with this one. The extractor loads on the first `embed`.
 */
export interface SpeakerEmbedder {
    readonly model: string;
    embed(samples: Float32Array): SpeakerEmbeddingResult;
}

export interface SpeakerEmbedderOptions {
    modelFile: string;
    /**
     * Threads inside one clip's model run. Measured 2026-11-18 on 40 clips of 1.5 to 9.5 s: 1 thread 1.14 s wall and
     * 1.14 CPU s, 2 threads 0.79 s and 1.57 CPU s, 4 threads 0.60 s and 2.38 CPU s. More threads in one clip cost
     * CPU; parallel clips in separate workers scale better.
     */
    threads?: number;
}

/**
 * The CPU provider only: the CoreML provider measured 0.89 CPU s against 1.14 on the same 40 clips with identical
 * vectors (cosine 1.0000), so most of the model stayed on the CPU (2026-11-18).
 */
export function createSpeakerEmbedder(options: SpeakerEmbedderOptions): SpeakerEmbedder {
    const model = `campplus:${createHash("sha256").update(readFileSync(options.modelFile)).digest("hex")}`;
    let extractor: SpeakerExtractor | undefined;
    const loaded = (): SpeakerExtractor => {
        if (!extractor) {
            const sherpa = requireLazy("sherpa-onnx-node") as SherpaModule;
            extractor = new sherpa.SpeakerEmbeddingExtractor({
                model: options.modelFile,
                numThreads: options.threads ?? 1,
                provider: "cpu",
                debug: false,
            });
        }

        return extractor;
    };

    return {
        model,
        embed: (samples) => speakerEmbeddingOf(loaded, samples),
    };
}

/** One clip through an extractor: quiet and too-short clips are unavailable, a broken vector throws. */
export function speakerEmbeddingOf(extractor: () => SpeakerExtractor, samples: Float32Array): SpeakerEmbeddingResult {
    const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / Math.max(1, samples.length));
    if (rms < 0.002) {
        return { unavailable: "Voice sample is quiet; identity remains unknown" };
    }

    const running = extractor();
    const stream = running.createStream();
    stream.acceptWaveform({ samples, sampleRate: SPEAKER_EMBEDDING_RATE });
    stream.inputFinished();
    if (!running.isReady(stream)) {
        return { unavailable: "Not enough speech for a speaker embedding" };
    }

    const embedding = Array.from(running.compute(stream));
    if (!embedding.length || embedding.some((n) => !Number.isFinite(n))) {
        throw new Error("Invalid local speaker embedding");
    }

    return { embedding };
}
