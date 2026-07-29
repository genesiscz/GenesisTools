import { statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import pc from "picocolors";
import { CredentialUnavailableError } from "../providers/credentials";
import { resolveProviderApiKey } from "../providers/resolve";
import { Transcriber } from "../tasks/Transcriber";
import type { TranscriptionSegment } from "../types";

/**
 * `deepgramUtteranceSegments` now lives in `./sdk-result` alongside the rest of
 * the SDK-result mapping, so the facade path and this one cannot drift. Kept
 * re-exported here because callers import it from this module.
 */
export { deepgramUtteranceSegments } from "./sdk-result";

export interface TranscriptionOptions {
    language?: string;
    provider?: string;
    model?: string;
    timestamp?: boolean;
    verbose?: boolean;
    /** Enable speaker diarization (Deepgram native; local pyannote otherwise). */
    diarize?: boolean;
    /** Expected speaker count for diarization clustering; omit/0 = auto-detect. */
    speakers?: number;
    /** Enable smart formatting/punctuation (Deepgram). */
    smartFormat?: boolean;
    /** Post-process repetition-loop cleanup. Default true; --no-clean disables. */
    clean?: boolean;
}

export interface TranscriptionResult {
    text: string;
    provider: string;
    model: string;
    duration?: number;
    confidence?: number;
    cost?: number;
    processingTime: number;
    segments?: TranscriptionSegment[];
    language?: string;
}

/**
 * The pre-facade cloud-ASR entry point, now a thin compat wrapper.
 *
 * It used to be the second full transcription implementation: its own vendor
 * switch building `createGroq`/`createDeepgram`/… by hand, its own six-entry
 * fallback ladder, its own per-provider default models. All three now exist once
 * — in the provider plugins, in `resolveForTask`'s availability chain and in
 * `tasks/task-models.ts` — so what is left here is the part `src/ask` actually
 * needs and the facade does not provide: file validation, and a result shaped
 * with `provider`/`model`/`processingTime` for the output manager.
 *
 * Two behaviours changed with the collapse and are deliberate:
 *   - A file too large for a single upload is now SPLIT (`Transcriber` chunks at
 *     24 MB) instead of steering the request to a vendor that accepts large
 *     uploads. The split path also diarizes over the whole buffer.
 *   - The fallback ORDER is the canonical chain from `resolveForTask`, not this
 *     class's private one, so a configured `defaults.task.transcribe` is honoured
 *     first — which it never was here.
 */
export class TranscriptionManager {
    private readonly SUPPORTED_FORMATS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mp4"];

    private readonly MIME_TYPES: Record<string, string> = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/m4a",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".webm": "audio/webm",
        ".mp4": "audio/mp4",
    };

    async transcribeAudio(filePath: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
        const startTime = Date.now();

        this.validateAudioFile(filePath);
        logger.info(`Transcribing ${pc.cyan(filePath)} (${this.formatFileSize(this.getFileSize(filePath))})`);

        // `auto` and `fallback` were this class's own sentinels for "choose one
        // for me" and "you are already inside the fallback pass". Neither has a
        // meaning after the collapse: choosing is what the ladder does, and
        // there is no second pass to guard against.
        const named = options.provider && options.provider !== "auto" && options.provider !== "fallback";
        const transcriber = await Transcriber.create({
            ...(named ? { provider: options.provider } : {}),
            ...(options.model ? { model: options.model } : {}),
        });

        logger.info(`Using ${pc.green(transcriber.providerType)} with model ${pc.yellow(transcriber.modelId)}`);

        try {
            const result = await transcriber.transcribe(filePath, {
                ...(options.language ? { language: options.language } : {}),
                ...(options.diarize !== undefined ? { diarize: options.diarize } : {}),
                ...(options.speakers !== undefined ? { speakers: options.speakers } : {}),
                ...(options.smartFormat !== undefined ? { smartFormat: options.smartFormat } : {}),
                ...(options.clean !== undefined ? { clean: options.clean } : {}),
            });

            const processingTime = Date.now() - startTime;
            logger.info(`Transcription completed in ${pc.green((processingTime / 1000).toFixed(1))}s`);

            return {
                text: result.text,
                provider: transcriber.providerType,
                model: transcriber.modelId,
                processingTime,
                segments: result.segments,
                language: result.language ?? options.language,
                duration: result.duration,
            };
        } catch (error) {
            const processingTime = Date.now() - startTime;
            logger.error(
                { error, provider: transcriber.providerType, model: transcriber.modelId, elapsedMs: processingTime },
                `Transcription failed after ${(processingTime / 1000).toFixed(1)}s (timeouts here usually mean a slow/degraded upload, not a code fault)`
            );
            throw error;
        } finally {
            transcriber.dispose();
        }
    }

    private validateAudioFile(filePath: string): void {
        try {
            const stats = statSync(filePath);

            if (!stats.isFile()) {
                throw new Error(`${filePath} is not a file`);
            }

            // Check file extension
            const ext = this.getFileExtension(filePath);
            if (!this.SUPPORTED_FORMATS.includes(ext)) {
                throw new Error(
                    `Unsupported audio format: ${ext}. Supported formats: ${this.SUPPORTED_FORMATS.join(", ")}`
                );
            }

            // Check file size (practical limit)
            const maxSize = 500 * 1024 * 1024; // 500MB practical limit
            if (stats.size > maxSize) {
                throw new Error(
                    `File too large: ${this.formatFileSize(stats.size)}. Maximum size: ${this.formatFileSize(maxSize)}`
                );
            }
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
                throw new Error(`File not found: ${filePath}`);
            }
            throw error;
        }
    }

    private getFileSize(filePath: string): number {
        return statSync(filePath).size;
    }

    private getFileExtension(filePath: string): string {
        const ext = filePath.toLowerCase().split(".").pop();
        return ext ? `.${ext}` : "";
    }

    private formatFileSize(bytes: number): string {
        const units = ["B", "KB", "MB", "GB"];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
    }

    getMimeType(filePath: string): string {
        const ext = this.getFileExtension(filePath);
        return this.MIME_TYPES[ext] || "audio/mpeg";
    }

    getSupportedFormats(): string[] {
        return [...this.SUPPORTED_FORMATS];
    }

    /** Async since the ladder may read the config; the only caller already awaited. */
    async getAvailableProviders(): Promise<string[]> {
        const providers: string[] = [];

        for (const provider of ["groq", "openrouter", "openai", "assemblyai", "deepgram", "gladia"]) {
            if (await hasUsableKey(provider)) {
                providers.push(provider);
            }
        }

        return providers;
    }

    async getTranscriptionInfo(): Promise<{
        availableProviders: string[];
        supportedFormats: string[];
        maxFileSize: string;
    }> {
        return {
            availableProviders: await this.getAvailableProviders(),
            supportedFormats: this.getSupportedFormats(),
            maxFileSize: "500MB",
        };
    }
}

/**
 * The api key for a vendor, or null when none resolves.
 *
 * `resolveProviderApiKey` throws when it finds nothing, which is the right shape
 * for a caller that must have a key; here "no key" is just "skip this vendor",
 * so the throw becomes a null and every other error still propagates.
 */
async function providerApiKeyOrNull(providerId: string): Promise<string | null> {
    try {
        const resolved = await resolveProviderApiKey(providerId);
        return resolved.apiKey ?? null;
    } catch (err) {
        if (err instanceof CredentialUnavailableError) {
            logger.debug({ provider: providerId }, "no transcription key resolves for this provider");
            return null;
        }

        throw err;
    }
}

async function hasUsableKey(providerId: string): Promise<boolean> {
    return (await providerApiKeyOrNull(providerId)) !== null;
}

/**
 * @deprecated Use `ai.transcribe` (`../tasks/facade`). This singleton remains for
 * the `src/ask` call sites that also need `provider`/`model`/`processingTime`.
 */
export const transcriptionManager = new TranscriptionManager();
