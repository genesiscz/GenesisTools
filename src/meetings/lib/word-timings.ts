import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execTool } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    makeWordTimingArtifact,
    WordTimingCache,
    type WordTimingFile,
    type WordTimingRead,
    type WordTimingSource,
    wordTimingFile,
    wordTimingHash,
    wordTimingTranscriptFingerprint,
} from "@genesiscz/utils/meetings/word-timing-cache";
import type { WordTimingLine } from "@genesiscz/utils/meetings/word-timings";
import { LockTimeoutError, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import {
    cachedWordTimingModel,
    type WordTimingWorkerInput,
    type WordTimingWorkerResult,
    wordTimingWorkerInputSchema,
    wordTimingWorkerResultSchema,
} from "./word-timing-worker";

export interface WordTimingInput {
    lines: WordTimingLine[];
    audioPath: string;
    live: boolean;
}
export interface WordTimingGenerateOptions {
    meeting: string;
    window: { fromSec: number; toSec: number };
    model: string;
    language?: string;
    signal?: AbortSignal;
    progress?: (update: { fraction?: number; label?: string }) => void;
}
export interface WordTimingGenerateDeps {
    read: () => Promise<WordTimingInput>;
    cache?: WordTimingCache;
    modelFiles?: (model: string) => Promise<WordTimingFile[]>;
    infer?: (input: WordTimingWorkerInput, signal: AbortSignal, timeoutMs: number) => Promise<WordTimingWorkerResult>;
}
export interface WordTimingGenerateResult {
    meeting: string;
    cacheRevision: string;
    reused: boolean;
    window: { fromSec: number; toSec: number };
    coverage: WordTimingRead<WordTimingLine>["wordTimings"]["windows"][number]["coverage"];
    provenance: WordTimingSource;
}

export function meetingWordTimingCache(meeting: string): WordTimingCache {
    return new WordTimingCache(toolDataDir("meetings-cache", "word-timings", wordTimingHash(meeting)));
}

interface Consumer {
    progress?: WordTimingGenerateOptions["progress"];
}
interface SharedGeneration {
    controller: AbortController;
    signal: AbortSignal;
    consumers: Set<Consumer>;
    promise: Promise<WordTimingGenerateResult>;
    finished: boolean;
}
const generations = new Map<string, SharedGeneration>();

function sharedGeneration(
    key: string,
    options: WordTimingGenerateOptions,
    run: (
        signal: AbortSignal,
        progress: NonNullable<WordTimingGenerateOptions["progress"]>
    ) => Promise<WordTimingGenerateResult>
): Promise<WordTimingGenerateResult> {
    options.signal?.throwIfAborted();
    let shared = generations.get(key);
    if (!shared || shared.signal.aborted) {
        const controller = new AbortController();
        // The microtask starts after the entry and its consumer have been installed.
        let entry: SharedGeneration;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
        const promise = Promise.resolve()
            .then(() =>
                run(signal, (update) => {
                    for (const consumer of entry.consumers) {
                        consumer.progress?.(update);
                    }
                })
            )
            .finally(() => {
                entry.finished = true;
                if (generations.get(key) === entry) {
                    generations.delete(key);
                }
            });
        entry = { controller, signal, consumers: new Set(), promise, finished: false };
        void entry.promise.catch(() => undefined);
        generations.set(key, entry);
        shared = entry;
    }
    const entry = shared;
    return new Promise((resolve, reject) => {
        const consumer = { progress: options.progress };
        let settled = false;
        const finish = () => {
            settled = true;
            options.signal?.removeEventListener("abort", abort);
            entry.consumers.delete(consumer);
            if (!entry.finished && entry.consumers.size === 0) {
                entry.controller.abort();
            }
        };
        const abort = () => {
            if (!settled) {
                finish();
                reject(options.signal?.reason ?? new DOMException("Cancelled", "AbortError"));
            }
        };
        entry.consumers.add(consumer);
        options.signal?.addEventListener("abort", abort, { once: true });
        entry.promise.then(
            (result) => {
                if (!settled) {
                    finish();
                    resolve(result);
                }
            },
            (error) => {
                if (!settled) {
                    finish();
                    reject(error);
                }
            }
        );
        if (options.signal?.aborted) {
            abort();
        }
    });
}

async function inferInChild(
    input: WordTimingWorkerInput,
    signal: AbortSignal,
    timeoutMs: number
): Promise<WordTimingWorkerResult> {
    const result = await execTool(["meetings", "word-timings", "_worker"], {
        stdin: SafeJSON.stringify(input),
        timeout: timeoutMs,
        signal,
        maxOutputBytes: 2 * 1024 * 1024,
    });
    signal.throwIfAborted();
    if (!result.success || result.timedOut || result.truncated) {
        throw new Error(
            `Word timing worker failed${result.timedOut ? " at its deadline" : ""}: ${result.stderr.slice(-1500)}`
        );
    }
    return wordTimingWorkerResultSchema.parse(SafeJSON.parse(result.stdout, { strict: true }));
}

/** Explicit generation only. The read path never enters this function. Equal callers share one cancellable job. */
export async function generateWordTimings(
    options: WordTimingGenerateOptions,
    deps: WordTimingGenerateDeps
): Promise<WordTimingGenerateResult> {
    options.signal?.throwIfAborted();
    wordTimingWorkerInputSchema.pick({ window: true, model: true, language: true }).parse({
        window: options.window,
        model: options.model,
        ...(options.language ? { language: options.language } : {}),
    });
    const duration = options.window.toSec - options.window.fromSec;
    if (!(duration > 0 && duration <= 20)) {
        throw new Error("Choose a word timing window between zero and 20 seconds");
    }
    const initial = await deps.read();
    if (initial.live) {
        throw new Error("Stop the recording before generating word timings");
    }
    const audio = wordTimingFile(initial.audioPath);
    const fingerprint = wordTimingTranscriptFingerprint(initial.lines);
    const cache = deps.cache ?? meetingWordTimingCache(options.meeting);
    const files = await (deps.modelFiles ?? cachedWordTimingModel)(options.model);
    options.signal?.throwIfAborted();
    const key = wordTimingHash([
        cache.folder,
        options.window,
        options.model,
        options.language,
        audio,
        files,
        fingerprint,
    ]);
    return sharedGeneration(key, options, async (signal, progress) => {
        const deadline = Date.now() + 120_000;
        const remaining = () => Math.max(1, deadline - Date.now());
        mkdirSync(dirname(cache.folder), { recursive: true });
        progress({ label: "Waiting for local word timing generation" });
        while (true) {
            signal.throwIfAborted();
            try {
                return await withFileLock(
                    join(dirname(cache.folder), "generation.lock"),
                    async () => {
                        signal.throwIfAborted();
                        const fresh = await deps.read();
                        if (
                            fresh.live ||
                            wordTimingTranscriptFingerprint(fresh.lines) !== fingerprint ||
                            wordTimingHash(wordTimingFile(fresh.audioPath)) !== wordTimingHash(audio)
                        ) {
                            throw new Error("Meeting input changed before word timing generation");
                        }
                        const cached = cache.reusable(options.window, audio, files, options.model, options.language);
                        progress({
                            label: cached ? "Reusing saved acoustic evidence" : "Generating local word timings",
                        });
                        const result = cached
                            ? { words: cached.rawWords, pcmSha256: cached.source.pcmSha256, modelFiles: files }
                            : await (deps.infer ?? inferInChild)(
                                  {
                                      audioPath: fresh.audioPath,
                                      window: options.window,
                                      model: options.model,
                                      ...(options.language ? { language: options.language } : {}),
                                  },
                                  signal,
                                  remaining()
                              );
                        signal.throwIfAborted();
                        const final = await deps.read();
                        if (
                            final.live ||
                            wordTimingTranscriptFingerprint(final.lines) !== fingerprint ||
                            wordTimingHash(wordTimingFile(final.audioPath)) !== wordTimingHash(audio) ||
                            wordTimingHash(result.modelFiles) !== wordTimingHash(files)
                        ) {
                            throw new Error("Meeting or model input changed during word timing generation");
                        }
                        const artifact = makeWordTimingArtifact({
                            window: options.window,
                            audio,
                            modelFiles: files,
                            modelId: options.model,
                            language: options.language,
                            pcmSha256: result.pcmSha256,
                            words: result.words,
                            lines: final.lines,
                            ...(cached ? { now: cached.source.generatedAt } : {}),
                        });
                        if (!cached || cached.transcriptFingerprint !== fingerprint) {
                            progress({ label: "Saving word timing evidence" });
                            await cache.publish(artifact, signal);
                        }
                        signal.throwIfAborted();
                        const read = cache.read(final.lines);
                        const window = read.wordTimings.windows.find(
                            (window) =>
                                window.fromSec === options.window.fromSec && window.toSec === options.window.toSec
                        );
                        if (!window) {
                            throw new Error("Published word timings became stale before readback");
                        }
                        progress({
                            fraction: 1,
                            label: `Matched ${window.coverage.matchedWords} of ${window.coverage.eligibleWords} words`,
                        });
                        return {
                            meeting: options.meeting,
                            cacheRevision: read.wordTimings.revision,
                            reused: cached !== undefined,
                            window: options.window,
                            coverage: window.coverage,
                            provenance: artifact.source,
                        };
                    },
                    Math.min(100, remaining())
                );
            } catch (error) {
                if (!(error instanceof LockTimeoutError)) {
                    throw error;
                }
            }
        }
    });
}
