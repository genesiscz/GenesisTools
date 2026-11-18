import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "@genesiscz/utils/ai/local/artifacts";
import { EMBEDDING_MODEL } from "@genesiscz/utils/ai/local/runtimes/sherpa/models";
import {
    createSpeakerEmbedder,
    type SpeakerEmbedder,
} from "@genesiscz/utils/ai/local/runtimes/sherpa/speaker-embedding";
import { toFloat32AudioWindow } from "@genesiscz/utils/audio/converter";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { clearOwnBackground } from "@genesiscz/utils/process/priority";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { VoiceLineCache, voiceLineCachePath } from "./voice-line-cache";

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
/** A sample that cannot be scored by its nature (no model, too short, quiet, too little speech): identity stays unknown. */
export class VoiceUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "VoiceUnavailableError";
    }
}

let runtime: SpeakerEmbedder | undefined;
let selectedModelFile = EMBEDDING_MODEL.file;
/** The speaker model of this process (the sherpa runtime's embedder, src/utils/ai/local/runtimes/sherpa). */
export function localVoiceBackend(): SpeakerEmbedder {
    if (runtime) {
        return runtime;
    }
    if (!existsSync(selectedModelFile)) {
        throw new VoiceUnavailableError("Speaker model unavailable; run meetings voice prepare explicitly");
    }
    runtime = createSpeakerEmbedder({ modelFile: selectedModelFile, threads: 1 });
    return runtime;
}
export async function embedVoice(options: {
    audioPath: string;
    channel: 0 | 1;
    fromSec: number;
    toSec: number;
    workerPrefix?: readonly string[];
    /** The worker takes itself out of background first (`clearOwnBackground`): the voice pass at normal priority. */
    clearBackground?: boolean;
}): Promise<{ model: string; embedding: number[] }> {
    if (options.toSec - options.fromSec < 1.5) {
        throw new VoiceUnavailableError("Voice sample needs at least 1.5 seconds of confirmed single-speaker speech");
    }
    if (options.workerPrefix) {
        const input = voiceSampleRequestSchema.parse(options);
        return voiceSampleSchema.pick({ model: true, embedding: true }).parse(
            await runVoiceWorker({
                workerPrefix: options.workerPrefix,
                clearBackground: options.clearBackground === true,
                request: { kind: "sample", input },
            })
        );
    }
    const backend = localVoiceBackend();
    const samples = await toFloat32AudioWindow(options.audioPath, {
        ...options,
        decoderThreads: 1,
        timeoutMs: 120_000,
    });
    return embeddingOf(samples, backend);
}

function embeddingOf(
    samples: Float32Array,
    backend: ReturnType<typeof localVoiceBackend>
): { model: string; embedding: number[] } {
    const result = backend.embed(samples);
    if ("unavailable" in result) {
        throw new VoiceUnavailableError(result.unavailable);
    }

    return { model: backend.model, embedding: result.embedding };
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

const voiceLineRequestSchema = z.object({
    audioPath: z.string(),
    spans: z.array(z.object({ index: z.number().int(), fromSec: z.number(), toSec: z.number() })),
    channels: z.array(
        z.object({
            channel: z.union([z.literal(0), z.literal(1)]),
            track: z.enum(["raw-mic", "isolated-call", "clean-mic"]),
        })
    ),
    cachePath: z.string().optional(),
});
const voiceSampleRequestSchema = z.object({
    audioPath: z.string(),
    channel: z.union([z.literal(0), z.literal(1)]),
    fromSec: z.number(),
    toSec: z.number(),
});
const voiceWorkerRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("lines"), input: voiceLineRequestSchema }),
    z.object({ kind: z.literal("sample"), input: voiceSampleRequestSchema }),
]);
const voiceWorkerEnvelopeSchema = z.object({
    request: voiceWorkerRequestSchema,
    modelFile: z.string(),
    clearBackground: z.boolean().default(false),
});
const workerResultSchema = z.array(
    z.object({
        index: z.number().int(),
        channels: z.array(
            z.intersection(
                z.object({
                    source: z.object({ audioPath: z.string(), size: z.number(), mtimeMs: z.number() }),
                    channel: z.union([z.literal(0), z.literal(1)]),
                    track: z.enum(["raw-mic", "isolated-call", "clean-mic"]),
                    fromSec: z.number(),
                    toSec: z.number(),
                }),
                z.discriminatedUnion("quality", [
                    z.object({
                        quality: z.literal("ready"),
                        model: z.string(),
                        embedding: z.array(z.number().finite()).min(1),
                    }),
                    z.object({ quality: z.literal("unknown"), reason: z.string() }),
                ])
            )
        ),
    })
);

async function runVoiceWorker(options: {
    request: z.infer<typeof voiceWorkerRequestSchema>;
    workerPrefix: readonly string[];
    clearBackground: boolean;
}): Promise<unknown> {
    const { workerPrefix, request, clearBackground } = options;
    const child = Bun.spawn([...workerPrefix, process.execPath, fileURLToPath(import.meta.url)], {
        env: env.getProcessEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // A background pass (taskpolicy -b) may yield for minutes while the foreground is busy.
        timeout: 1_800_000,
        killSignal: "SIGKILL",
    });
    child.stdin.write(SafeJSON.stringify({ request, modelFile: selectedModelFile, clearBackground }, { strict: true }));
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) {
        throw new Error(`Voice embedding worker failed (exit ${code}): ${stderr.slice(-1500)}`);
    }
    const result: unknown = SafeJSON.parse(stdout, { strict: true });
    const unavailable = z.object({ unavailable: z.string() }).safeParse(result);
    if (unavailable.success) {
        throw new VoiceUnavailableError(unavailable.data.unavailable);
    }
    return result;
}
/** Canonical per-line adapter for Listen and Room. Unknown channels never masquerade as empty embeddings. */
export async function embedVoiceLines(options: {
    audioPath: string;
    spans: readonly { index: number; fromSec: number; toSec: number }[];
    channels: readonly { channel: 0 | 1; track: VoiceEmbeddingProvenance["track"] }[];
    cachePath?: string;
    workerPrefix?: readonly string[];
    /** The worker takes itself out of background first (`clearOwnBackground`): the voice pass at normal priority. */
    clearBackground?: boolean;
}): Promise<LineEmbedding[]> {
    const stat = statSync(options.audioPath);
    const source = { audioPath: options.audioPath, size: stat.size, mtimeMs: stat.mtimeMs };
    const result: LineEmbedding[] = [];
    const windows = new Map<number, { fromSec: number; toSec: number; samples?: Float32Array }>();
    let cache: VoiceLineCache | undefined;
    let backend: ReturnType<typeof localVoiceBackend> | undefined;
    let backendError: unknown;
    if (options.spans.length && options.channels.length) {
        try {
            backend = localVoiceBackend();
            cache = new VoiceLineCache({
                source,
                model: backend.model,
                cachePath: options.cachePath ?? (await voiceLineCachePath(options.audioPath)),
            });
        } catch (error) {
            backendError = error;
            logger.debug({ error }, "Voice backend unavailable; line identities remain unknown");
        }
    }
    if (options.workerPrefix) {
        const saved: LineEmbedding[] = [];
        for (const span of options.spans) {
            const channels: ChannelEmbedding[] = [];
            for (const channel of options.channels) {
                const provenance = { source, ...channel, fromSec: span.fromSec, toSec: span.toSec };
                const hit = cache?.get(provenance);
                if (!hit) {
                    break;
                }
                channels.push({ ...provenance, ...hit });
            }
            if (channels.length !== options.channels.length) {
                break;
            }
            saved.push({ index: span.index, channels });
        }
        if (saved.length === options.spans.length) {
            return saved;
        }
        return workerResultSchema.parse(
            await runVoiceWorker({
                request: { kind: "lines", input: voiceLineRequestSchema.parse(options) },
                workerPrefix: options.workerPrefix,
                clearBackground: options.clearBackground === true,
            })
        );
    }
    for (const span of options.spans) {
        const channels: ChannelEmbedding[] = [];
        for (const channel of options.channels) {
            const provenance = { source, ...channel, fromSec: span.fromSec, toSec: span.toSec };
            const duration = span.toSec - span.fromSec;
            let window = windows.get(channel.channel);
            // Cache hits and failed decodes must keep the same window origin as a complete cold pass.
            if (
                Number.isFinite(span.fromSec) &&
                span.fromSec >= 0 &&
                duration >= 1.5 &&
                duration <= 60 &&
                (!window || span.fromSec < window.fromSec || span.toSec > window.toSec)
            ) {
                window = { fromSec: span.fromSec, toSec: span.fromSec + 60 };
                windows.set(channel.channel, window);
            }
            const cached = cache?.get(provenance);
            if (cached) {
                channels.push({ ...provenance, ...cached });
                continue;
            }
            try {
                if (!Number.isFinite(span.fromSec) || span.fromSec < 0 || !Number.isFinite(duration)) {
                    throw new VoiceUnavailableError("Voice line needs a finite nonnegative start and duration");
                }
                if (duration < 1.5 || duration > 60) {
                    throw new VoiceUnavailableError("Voice line needs 1.5 to 60 seconds of speech");
                }
                if (!backend) {
                    throw backendError;
                }
                if (!window) {
                    throw new VoiceUnavailableError("Voice line needs a finite nonnegative start");
                }
                if (!window.samples) {
                    window.samples = await toFloat32AudioWindow(options.audioPath, {
                        fromSec: window.fromSec,
                        toSec: window.toSec,
                        channel: channel.channel,
                        decoderThreads: 1,
                        timeoutMs: 120_000,
                    });
                }
                const samples = window.samples.slice(
                    Math.round((span.fromSec - window.fromSec) * 16000),
                    Math.round((span.toSec - window.fromSec) * 16000)
                );
                const embedding = embeddingOf(samples, backend);
                channels.push({ ...provenance, ...embedding, quality: "ready" });
                cache?.set(provenance, { ...embedding, quality: "ready" });
            } catch (error) {
                const unknown = {
                    quality: "unknown",
                    reason: error instanceof Error ? error.message : String(error),
                } as const;
                channels.push({ ...provenance, ...unknown });
                if (error instanceof VoiceUnavailableError) {
                    cache?.set(provenance, unknown);
                }
            }
        }
        result.push({ index: span.index, channels });
    }
    cache?.save();
    return result;
}

async function runWorkerMain(): Promise<void> {
    const envelope = voiceWorkerEnvelopeSchema.parse(SafeJSON.parse(await Bun.stdin.text(), { strict: true }));
    if (envelope.clearBackground && !clearOwnBackground()) {
        logger.warn("Voice worker could not leave background priority; it runs at its parent's priority");
    }

    selectedModelFile = envelope.modelFile;
    const request = envelope.request;
    try {
        const result =
            request.kind === "sample" ? await embedVoice(request.input) : await embedVoiceLines(request.input);
        out.print(SafeJSON.stringify(result, { strict: true }));
    } catch (error) {
        if (!(error instanceof VoiceUnavailableError)) {
            throw error;
        }
        out.print(SafeJSON.stringify({ unavailable: error.message }, { strict: true }));
    }
}

if (import.meta.main) {
    // Folder discovery imports record, whose schemas import this module. Finish loading before doing that work.
    void runWorkerMain().catch((error) => {
        logger.error({ error }, "Voice worker failed");
        process.exitCode = 1;
    });
}
