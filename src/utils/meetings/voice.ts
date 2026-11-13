import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { ArtifactStore } from "@genesiscz/utils/ai/local/artifacts";
import { EMBEDDING_MODEL } from "@genesiscz/utils/ai/local/runtimes/sherpa/models";
import { toFloat32AudioWindow } from "@genesiscz/utils/audio/converter";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";

export const voiceSampleSchema = z.object({
    person: z.string().min(1),
    model: z.string(),
    source: z.string(),
    channel: z.union([z.literal(0), z.literal(1)]),
    fromSec: z.number().nonnegative(),
    toSec: z.number().positive(),
    embedding: z.array(z.number().finite()).min(1),
    confirmed: z.literal(true),
});
export type VoiceSample = z.infer<typeof voiceSampleSchema>;
export const voiceMatchSchema = z.object({
    candidates: z.array(z.object({ person: z.string(), score: z.number().min(-1).max(1) })),
    person: z.string().optional(),
    quality: z.enum(["matched", "unknown"]),
    reason: z.string(),
    model: z.string(),
});
export const voiceEvidenceSchema = z.object({
    version: z.literal(1),
    source: z.string(),
    enrolment: z.string(),
    lines: z.record(z.string(), voiceMatchSchema),
});
export interface VoiceMatch {
    candidates: Array<{ person: string; score: number }>;
    person?: string;
    quality: "matched" | "unknown";
    reason: string;
    model: string;
}
interface VoiceStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
}
interface Extractor {
    createStream(): VoiceStream;
    isReady(stream: VoiceStream): boolean;
    compute(stream: VoiceStream): Float32Array;
}
interface Sherpa {
    SpeakerEmbeddingExtractor: new (config: {
        model: string;
        numThreads: number;
        provider: string;
        debug: boolean;
    }) => Extractor;
}

/** Explicit provisioning, reusing the canonical ungated artifact and cache. Never called by a read or scoring. */
export async function prepareVoiceModel(): Promise<string> {
    const [asset] = await ArtifactStore.default().ensure([
        { source: "url", locator: EMBEDDING_MODEL.url, file: EMBEDDING_MODEL.file },
    ]);
    if (!asset) {
        throw new Error("Speaker model did not resolve");
    }
    return asset.path;
}
let runtime: { model: string; extractor: Extractor } | undefined;
export function localVoiceBackend(): { model: string; extractor: Extractor } {
    if (runtime) {
        return runtime;
    }
    if (!existsSync(EMBEDDING_MODEL.file)) {
        throw new Error("Speaker model unavailable; run meetings voice prepare explicitly");
    }
    const model = `campplus:${createHash("sha256").update(readFileSync(EMBEDDING_MODEL.file)).digest("hex")}`;
    const sherpa: Sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
    runtime = {
        model,
        extractor: new sherpa.SpeakerEmbeddingExtractor({
            model: EMBEDDING_MODEL.file,
            numThreads: 2,
            provider: "cpu",
            debug: false,
        }),
    };
    return runtime;
}
export async function embedVoice(options: {
    audioPath: string;
    channel: 0 | 1;
    fromSec: number;
    toSec: number;
}): Promise<{ model: string; embedding: number[] }> {
    if (options.toSec - options.fromSec < 1.5) {
        throw new Error("Voice sample needs at least 1.5 seconds of confirmed single-speaker speech");
    }
    const backend = localVoiceBackend();
    const samples = await toFloat32AudioWindow(options.audioPath, options);
    const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / Math.max(1, samples.length));
    if (rms < 0.002) {
        throw new Error("Voice sample is quiet; identity remains unknown");
    }
    const stream = backend.extractor.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    stream.inputFinished();
    if (!backend.extractor.isReady(stream)) {
        throw new Error("Not enough speech for a speaker embedding");
    }
    const embedding = Array.from(backend.extractor.compute(stream));
    if (!embedding.length || embedding.some((n) => !Number.isFinite(n))) {
        throw new Error("Invalid local speaker embedding");
    }
    return { model: backend.model, embedding };
}
export function readVoiceSamples(file: string): VoiceSample[] {
    return existsSync(file) ? z.array(voiceSampleSchema).parse(SafeJSON.parse(readFileSync(file, "utf8"))) : [];
}
export function saveVoiceSample(file: string, sample: VoiceSample): void {
    const checked = voiceSampleSchema.parse(sample);
    if (checked.toSec <= checked.fromSec) {
        throw new Error("Invalid enrolment interval");
    }
    const samples = readVoiceSamples(file).filter(
        (s) =>
            !(
                s.person === sample.person &&
                s.source === sample.source &&
                s.channel === sample.channel &&
                s.fromSec === sample.fromSec &&
                s.toSec === sample.toSec
            )
    );
    atomicWriteFileSync(file, SafeJSON.stringify([...samples, checked]));
}
export function scoreVoice(options: {
    model: string;
    embedding: number[];
    samples: VoiceSample[];
    threshold?: number;
    margin?: number;
}): VoiceMatch {
    const scores = new Map<string, number>();
    for (const sample of options.samples) {
        if (sample.model !== options.model || sample.embedding.length !== options.embedding.length) {
            continue;
        }
        let dot = 0,
            aa = 0,
            bb = 0;
        for (let i = 0; i < sample.embedding.length; i++) {
            const a = sample.embedding[i]!,
                b = options.embedding[i]!;
            dot += a * b;
            aa += a * a;
            bb += b * b;
        }
        if (aa <= 0 || bb <= 0 || !Number.isFinite(dot)) {
            continue;
        }
        const score = Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
        scores.set(sample.person, Math.max(scores.get(sample.person) ?? -1, score));
    }
    const candidates = [...scores].map(([person, score]) => ({ person, score })).sort((a, b) => b.score - a.score);
    const [first, second] = candidates;
    const matched =
        first &&
        first.score >= (options.threshold ?? 0.65) &&
        (!second || first.score - second.score >= (options.margin ?? 0.1));
    return {
        model: options.model,
        candidates,
        ...(matched ? { person: first.person } : {}),
        quality: matched ? "matched" : "unknown",
        reason: matched
            ? "cosine threshold and runner-up margin met; score is not a probability"
            : "missing, incompatible, weak or ambiguous enrolment",
    };
}

export interface VoiceEmbeddingProvenance {
    source: { audioPath: string; size: number; mtimeMs: number };
    channel: 0 | 1;
    fromSec: number;
    toSec: number;
    track: "raw-mic" | "isolated-call" | "clean-mic";
}
export type ChannelEmbedding = VoiceEmbeddingProvenance &
    ({ quality: "ready"; model: string; embedding: number[] } | { quality: "unknown"; reason: string });
export interface LineEmbedding {
    index: number;
    channels: ChannelEmbedding[];
}
/** Canonical per-line adapter for Listen and Room. Unknown channels never masquerade as empty embeddings. */
export async function embedVoiceLines(options: {
    audioPath: string;
    spans: readonly { index: number; fromSec: number; toSec: number }[];
    channels: readonly { channel: 0 | 1; track: VoiceEmbeddingProvenance["track"] }[];
}): Promise<LineEmbedding[]> {
    const stat = statSync(options.audioPath);
    const source = { audioPath: options.audioPath, size: stat.size, mtimeMs: stat.mtimeMs };
    const result: LineEmbedding[] = [];
    for (const span of options.spans) {
        const channels: ChannelEmbedding[] = [];
        for (const channel of options.channels) {
            const provenance = { source, ...channel, fromSec: span.fromSec, toSec: span.toSec };
            try {
                const embedding = await embedVoice({
                    audioPath: options.audioPath,
                    channel: channel.channel,
                    fromSec: span.fromSec,
                    toSec: span.toSec,
                });
                channels.push({ ...provenance, ...embedding, quality: "ready" });
            } catch (error) {
                channels.push({
                    ...provenance,
                    quality: "unknown",
                    reason: error instanceof Error ? error.message : String(error),
                });
            }
        }
        result.push({ index: span.index, channels });
    }
    return result;
}
