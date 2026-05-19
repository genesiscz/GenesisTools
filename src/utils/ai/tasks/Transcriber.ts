import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioProcessor } from "@app/ask/audio/AudioProcessor";
import { logger } from "@app/logger";
import { rateLimitAwareDelay, retry } from "@app/utils/async";
import { diarizeLocal } from "@app/utils/audio/diarize-local";
import { CLOUD_PROVIDER_TYPES } from "@app/utils/config/ai.types";
import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import { assignSpeakers } from "../transcription/align-speakers";
import { cleanRepetitions } from "../transcription/repetition-cleanup";
import type {
    AIProviderType,
    AITranscriptionProvider,
    TranscribeOptions,
    TranscriptionResult,
    TranscriptionSegment,
} from "../types";

const MAX_CLOUD_BYTES = 24 * 1024 * 1024;
const RETRY_DELAY = rateLimitAwareDelay();

/** Don't retry permanent errors -- only transient/rate-limit failures are worth retrying */
function shouldRetryTransient(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    if (/\b(401|403|404|400)\b/.test(msg)) {
        return false;
    }

    if (/\b(invalid.api.key|unauthorized|forbidden|model.not.found)\b/i.test(msg)) {
        return false;
    }

    // Permanent capability/format mismatches — retrying just repeats the error.
    if (/unsupported.model.version|does not support the format|unsupported.format/i.test(msg)) {
        return false;
    }

    return true;
}

export class Transcriber {
    private provider: AITranscriptionProvider;

    private constructor(provider: AITranscriptionProvider) {
        this.provider = provider;
    }

    static async create(options?: { provider?: string; model?: string; persist?: boolean }): Promise<Transcriber> {
        const config = await AIConfig.load();

        if (options?.persist && options.provider) {
            await config.setTask("transcribe", {
                provider: options.provider as AIProviderType,
                model: options.model,
            });
        }

        const provider = await getProviderForTask("transcribe", config);

        if (!("transcribe" in provider)) {
            throw new Error(`Provider "${provider.type}" does not support transcription`);
        }

        return new Transcriber(provider as AITranscriptionProvider);
    }

    async transcribe(audioOrPath: Buffer | string, options?: TranscribeOptions): Promise<TranscriptionResult> {
        let audio: Buffer;

        if (typeof audioOrPath === "string") {
            const file = Bun.file(audioOrPath);
            const arrayBuffer = await file.arrayBuffer();
            audio = Buffer.from(arrayBuffer);
        } else {
            audio = audioOrPath;
        }

        if (CLOUD_PROVIDER_TYPES.has(this.provider.type) && audio.length > MAX_CLOUD_BYTES) {
            // Only Deepgram accepts large single uploads AND diarizes natively,
            // so only it benefits from (and survives) bypassing the size-split.
            // OpenAI/Groq reject >25 MB, so they must still chunk — local
            // diarization runs on the full original buffer regardless
            // (maybeDiarizeLocal), so the global-label invariant is preserved.
            const deepgramNativeDiarize = options?.diarize === true && this.provider.type === "deepgram";

            if (deepgramNativeDiarize) {
                logger.info(
                    "Deepgram diarization — bypassing size-split (accepts large uploads; one request ⇒ one global speaker label space)"
                );
            } else {
                return this.transcribeChunked(
                    audio,
                    typeof audioOrPath === "string" ? audioOrPath : undefined,
                    options
                );
            }
        }

        const result = await retry(() => this.provider.transcribe(audio, options), {
            maxAttempts: 1,
            getDelay: RETRY_DELAY,
            shouldRetry: shouldRetryTransient,
            onRetry: (attempt, delay) => {
                logger.warn(
                    { attempt, maxAttempts: 1, nextDelayMs: delay, audioBytes: audio.length },
                    "Transcription attempt failed (transient) — retrying; each retry re-uploads the full audio"
                );
            },
        });

        const cleaned = this.maybeClean(result, options);
        return this.maybeDiarizeLocal(cleaned, audio, options);
    }

    private maybeClean(r: TranscriptionResult, options?: TranscribeOptions): TranscriptionResult {
        if (options?.clean === false) {
            return r;
        }

        const c = cleanRepetitions({ text: r.text, segments: r.segments });
        return { ...r, text: c.text, segments: c.segments };
    }

    /**
     * Local speaker diarization for providers that don't return speakers
     * natively (Whisper/gpt-4o/local). Runs on the FULL original audio buffer
     * (never a chunk) so the label space is global — the cross-chunk-remap
     * problem is designed out, not patched. Deepgram-with-utterances already
     * has per-segment speakers, so this is a no-op there.
     */
    private async maybeDiarizeLocal(
        r: TranscriptionResult,
        audio: Buffer,
        options?: TranscribeOptions
    ): Promise<TranscriptionResult> {
        if (!options?.diarize || !r.segments?.length || r.segments.some((s) => s.speaker)) {
            return r;
        }

        const turns = await diarizeLocal(audio, { speakers: options.speakers });

        if (turns.length === 0) {
            return r;
        }

        return { ...r, segments: assignSpeakers(r.segments, turns) };
    }

    private async transcribeChunked(
        audio: Buffer,
        sourcePath: string | undefined,
        options?: TranscribeOptions
    ): Promise<TranscriptionResult> {
        const chunkDir = join(tmpdir(), `transcribe-chunks-${Date.now()}`);
        let inputPath = sourcePath;

        try {
            if (!inputPath) {
                inputPath = join(tmpdir(), `transcribe-input-${Date.now()}.wav`);
                await writeFile(inputPath, audio);
            }

            options?.onProgress?.({ phase: "transcribe", message: "Splitting large audio for cloud upload..." });
            const chunkPaths = await audioProcessor.splitAudioBySize(inputPath, chunkDir, MAX_CLOUD_BYTES);

            const allSegments: TranscriptionSegment[] = [];
            const texts: string[] = [];
            let timeOffset = 0;

            for (let i = 0; i < chunkPaths.length; i++) {
                options?.onProgress?.({
                    phase: "transcribe",
                    percent: Math.round((i / chunkPaths.length) * 100),
                    message: `Transcribing chunk ${i + 1}/${chunkPaths.length}...`,
                });

                const chunkBuf = await readFile(chunkPaths[i]);
                const result = await this.provider.transcribe(Buffer.from(chunkBuf), {
                    ...options,
                    onProgress: undefined,
                    onSegment: undefined,
                });

                texts.push(result.text);

                if (result.segments) {
                    for (const seg of result.segments) {
                        const adjusted: TranscriptionSegment = {
                            text: seg.text,
                            start: seg.start + timeOffset,
                            end: seg.end + timeOffset,
                        };
                        allSegments.push(adjusted);
                        options?.onSegment?.(adjusted);
                    }
                }

                if (result.duration) {
                    timeOffset += result.duration;
                } else if (result.segments?.length) {
                    timeOffset = result.segments[result.segments.length - 1].end;
                }
            }

            const stitched = this.maybeClean(
                {
                    text: texts.join(" "),
                    segments: allSegments.length > 0 ? allSegments : undefined,
                    language: options?.language,
                    duration: timeOffset > 0 ? timeOffset : undefined,
                },
                options
            );

            // `audio` here is the full original buffer (never a chunk) — the
            // designed-out invariant: diarization always sees the whole file.
            return this.maybeDiarizeLocal(stitched, audio, options);
        } finally {
            if (!sourcePath && inputPath && existsSync(inputPath)) {
                await rm(inputPath, { force: true }).catch(() => {});
            }

            if (existsSync(chunkDir)) {
                await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
            }
        }
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
