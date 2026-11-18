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
import { splitLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { clearOwnBackground } from "@genesiscz/utils/process/priority";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";
import { z } from "zod";
import { VoiceLineCache, voiceLineCachePath, voiceLineResultSchema } from "./voice-line-cache";

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
    clips: z.array(
        z.object({
            fromSec: z.number(),
            toSec: z.number(),
            windowFromSec: z.number(),
            channels: z.array(z.union([z.literal(0), z.literal(1)])),
        })
    ),
    progress: z.boolean(),
});
type VoiceChunk = z.infer<typeof voiceLineRequestSchema>;
type VoiceClip = VoiceChunk["clips"][number];
// A decoder or process failure can succeed on retry. Only intrinsic unknowns go in the cache.
const workerResultSchema = z.array(z.array(z.union([voiceLineResultSchema, z.object({ error: z.string() })])));
type ChunkResults = z.infer<typeof workerResultSchema>;
export type VoiceProgress = (done: number, total: number) => void;
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

async function workerStderr(stream: ReadableStream<Uint8Array>, onProgress?: (done: number) => void): Promise<string> {
    let tail = "";
    for await (const line of splitLines(stream)) {
        const progress = /^\{"done":(\d+)\}$/.exec(line);
        if (progress) {
            onProgress?.(Number(progress[1]));
        } else if (line) {
            tail = `${tail}\n${line}`.slice(-1500);
        }
    }
    return tail.trim();
}

async function runVoiceWorker(options: {
    request: z.infer<typeof voiceWorkerRequestSchema>;
    workerPrefix: readonly string[];
    clearBackground: boolean;
    onProgress?: (done: number) => void;
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
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        workerStderr(child.stderr, options.onProgress),
        child.exited,
        child.stdin.end(),
    ]);
    if (code !== 0) {
        throw new Error(`Voice embedding worker failed (exit ${code}): ${stderr}`);
    }
    const result: unknown = SafeJSON.parse(stdout, { strict: true });
    const unavailable = z.object({ unavailable: z.string() }).safeParse(result);
    if (unavailable.success) {
        throw new VoiceUnavailableError(unavailable.data.unavailable);
    }
    return result;
}

function lineBackend(): SpeakerEmbedder | Error {
    try {
        return localVoiceBackend();
    } catch (error) {
        logger.debug({ error }, "Voice backend unavailable; line identities remain unknown");
        return error instanceof Error ? error : new Error(String(error));
    }
}

async function embedChunk(options: {
    input: VoiceChunk;
    backend: SpeakerEmbedder | Error;
    onProgress?: (done: number) => void;
}): Promise<ChunkResults> {
    const { input, backend, onProgress } = options;
    const results: ChunkResults = [];
    const windows = new Map<number, { fromSec: number; samples: Float32Array }>();
    for (const clip of input.clips) {
        const row: ChunkResults[number] = [];
        for (const channel of clip.channels) {
            try {
                const duration = clip.toSec - clip.fromSec;
                if (clip.fromSec < 0 || !Number.isFinite(duration)) {
                    throw new VoiceUnavailableError("Voice line needs a finite nonnegative start and duration");
                }
                if (duration < 1.5 || duration > 60) {
                    throw new VoiceUnavailableError("Voice line needs 1.5 to 60 seconds of speech");
                }
                if (backend instanceof Error) {
                    throw backend;
                }
                let window = windows.get(channel);
                if (!window || window.fromSec !== clip.windowFromSec) {
                    const samples = await toFloat32AudioWindow(input.audioPath, {
                        fromSec: clip.windowFromSec,
                        toSec: clip.windowFromSec + 60,
                        channel,
                        decoderThreads: 1,
                        timeoutMs: 120_000,
                    });
                    window = { fromSec: clip.windowFromSec, samples };
                    windows.set(channel, window);
                }
                const samples = window.samples.slice(
                    Math.round((clip.fromSec - window.fromSec) * 16000),
                    Math.round((clip.toSec - window.fromSec) * 16000)
                );
                row.push({ ...embeddingOf(samples, backend), quality: "ready" });
            } catch (error) {
                row.push(
                    error instanceof VoiceUnavailableError
                        ? { quality: "unknown", reason: error.message }
                        : { error: error instanceof Error ? error.message : String(error) }
                );
            }
        }
        results.push(row);
        onProgress?.(results.length);
    }
    return results;
}

interface PendingLine {
    position: number;
    clip: VoiceClip;
    missing: Array<{ slot: number; provenance: VoiceEmbeddingProvenance }>;
    results: ChunkResults[number];
}

/** Prefer whole decode windows. A short meeting can still use multiple workers with the explicit window origin. */
function splitVoiceWork(lines: PendingLine[], workers: number): PendingLine[][] {
    const ordered = lines.toSorted((a, b) => a.clip.fromSec - b.clip.fromSec);
    const count = Math.min(workers, ordered.length);
    const starts = ordered.flatMap((line, i) =>
        i === 0 || line.clip.windowFromSec !== ordered[i - 1]!.clip.windowFromSec ? [i] : []
    );
    const boundary = (i: number) =>
        starts.length >= count
            ? (starts[Math.floor((i * starts.length) / count)] ?? ordered.length)
            : Math.floor((i * ordered.length) / count);
    return Array.from({ length: count }, (_, i) => ordered.slice(boundary(i), boundary(i + 1)));
}

async function fillVoiceChunk(options: {
    chunk: PendingLine[];
    audioPath: string;
    workerPrefix?: readonly string[];
    clearBackground?: boolean;
    backend: SpeakerEmbedder | Error;
    advance?: (lines: number) => void;
}): Promise<void> {
    const { chunk, audioPath, workerPrefix, backend } = options;
    let reported = 0;
    const report = (done: number) => {
        if (done > reported && done <= chunk.length) {
            const delta = done - reported;
            reported = done;
            options.advance?.(delta);
        }
    };
    const input = { audioPath, clips: chunk.map((line) => line.clip), progress: !!options.advance };
    try {
        const rows = workerPrefix
            ? workerResultSchema.parse(
                  await runVoiceWorker({
                      request: { kind: "lines", input },
                      workerPrefix,
                      clearBackground: options.clearBackground === true,
                      onProgress: report,
                  })
              )
            : await embedChunk({ input, backend, onProgress: report });
        if (rows.length !== chunk.length || rows.some((row, i) => row.length !== chunk[i]!.missing.length)) {
            throw new Error("Voice worker returned an incomplete chunk");
        }
        for (const [i, line] of chunk.entries()) {
            line.results = rows[i]!;
        }
    } catch (error) {
        logger.warn({ error, lines: chunk.length }, "Voice embedding chunk failed");
        const reason = error instanceof Error ? error.message : String(error);
        for (const line of chunk) {
            line.results = line.missing.map(() => ({ error: reason }));
        }
    }
    // A process that exited midway still settles every unfinished line of its chunk as unknown.
    report(chunk.length);
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
    workers?: number;
    onProgress?: VoiceProgress;
}): Promise<LineEmbedding[]> {
    const { audioPath, spans, onProgress } = options;
    const stat = statSync(audioPath);
    const source = { audioPath, size: stat.size, mtimeMs: stat.mtimeMs };
    const result: LineEmbedding[] = spans.map(({ index }) => ({ index, channels: [] }));
    if (!spans.length || !options.channels.length) {
        onProgress?.(spans.length, spans.length);
        return result;
    }

    const backend = lineBackend();
    let cache: VoiceLineCache | undefined;
    if (!(backend instanceof Error)) {
        try {
            cache = new VoiceLineCache({
                source,
                model: backend.model,
                cachePath: options.cachePath ?? (await voiceLineCachePath(audioPath)),
            });
        } catch (error) {
            logger.debug({ error }, "Voice line cache unavailable; computing without it");
        }
    }
    const pending: PendingLine[] = [];
    let origin: number | undefined;
    for (const [position, { fromSec, toSec }] of spans.entries()) {
        const duration = toSec - fromSec;
        // Cache hits and failed decodes must keep the same window origin as a complete cold pass.
        if (
            fromSec >= 0 &&
            duration >= 1.5 &&
            duration <= 60 &&
            (origin === undefined || fromSec < origin || toSec > origin + 60)
        ) {
            origin = fromSec;
        }
        const missing: PendingLine["missing"] = [];
        for (const [slot, channel] of options.channels.entries()) {
            const provenance = { source, ...channel, fromSec, toSec };
            const hit = cache?.get(provenance);
            if (hit) {
                result[position]!.channels[slot] = { ...provenance, ...hit };
            } else if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
                const unknown = {
                    quality: "unknown",
                    reason: "Voice line needs a finite nonnegative start and duration",
                } as const;
                result[position]!.channels[slot] = { ...provenance, ...unknown };
                cache?.set(provenance, unknown);
            } else {
                missing.push({ slot, provenance });
            }
        }
        if (missing.length) {
            const channels = missing.map(({ provenance }) => provenance.channel);
            const clip = { fromSec, toSec, windowFromSec: origin ?? 0, channels };
            pending.push({ position, missing, clip, results: [] });
        }
    }

    let done = spans.length - pending.length;
    onProgress?.(done, spans.length);
    const workerPrefix = options.workerPrefix ?? (options.workers !== undefined ? [] : undefined);
    const workers = options.workers ?? 1;
    if (!Number.isSafeInteger(workers) || workers < 1) {
        throw new RangeError("Voice workers must be a positive integer");
    }
    const advance =
        onProgress &&
        ((lines: number) => {
            done += lines;
            onProgress(done, spans.length);
        });
    const chunks = splitVoiceWork(pending, workerPrefix ? workers : 1);
    await Promise.all(
        chunks.map((chunk) =>
            fillVoiceChunk({
                chunk,
                audioPath,
                workerPrefix,
                clearBackground: options.clearBackground,
                backend,
                advance,
            })
        )
    );

    // Commit in input order, independent of worker completion. For repeated millisecond keys the first
    // cacheable result wins, just as if each line had looked up the one before it in a serial pass.
    for (const line of pending) {
        for (const [i, { slot, provenance }] of line.missing.entries()) {
            const computed = line.results[i]!;
            const previous = cache?.get(provenance);
            const value =
                previous ?? ("error" in computed ? { quality: "unknown" as const, reason: computed.error } : computed);
            result[line.position]!.channels[slot] = { ...provenance, ...value };
            if (!previous && !("error" in computed)) {
                cache?.set(provenance, computed);
            }
        }
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
            request.kind === "sample"
                ? await embedVoice(request.input)
                : await embedChunk({
                      input: request.input,
                      backend: lineBackend(),
                      onProgress: request.input.progress
                          ? (done) => process.stderr.write(`{"done":${done}}\n`)
                          : undefined,
                  });
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
