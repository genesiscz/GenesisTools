import { statSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import type { TranscriptionModel } from "ai";
import { transcribe } from "ai";
import pc from "picocolors";
import { CredentialUnavailableError } from "../providers/credentials";
import { resolveProviderApiKey } from "../providers/resolve";
import type { TranscriptionCapableProvider, TranscriptionSegment } from "../types";
import { buildTranscriptionProviderOptions, mapSdkTranscription } from "./sdk-result";

function getTranscriptionModel(provider: TranscriptionCapableProvider, modelId: string): TranscriptionModel {
    const factory = provider.transcription ?? provider.transcriptionModel;

    if (!factory) {
        throw new Error("Provider does not support transcription models");
    }

    // SDK version skew: deepgram/groq return TranscriptionModelV3 while ai@5's
    // transcribe() is typed for V2. They are interop-compatible at runtime;
    // bridge the model type here at the single boundary (no `any`).
    return factory.call(provider, modelId) as TranscriptionModel;
}

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

        try {
            // Validate file
            this.validateAudioFile(filePath);

            // Get file size
            const fileSize = this.getFileSize(filePath);
            logger.info(`Transcribing ${pc.cyan(filePath)} (${this.formatFileSize(fileSize)})`);

            // Select best transcription model based on file size and options
            const transcriptionModel = await this.selectBestTranscriptionModel(
                fileSize,
                options.provider,
                options.model
            );

            if (!transcriptionModel) {
                throw new Error("No suitable transcription provider available");
            }

            logger.info(
                `Using ${pc.green(transcriptionModel.provider)} with model ${pc.yellow(transcriptionModel.model)}`
            );

            // Read audio file
            const audioBuffer = await Bun.file(filePath).arrayBuffer();

            // Perform transcription
            const model = getTranscriptionModel(transcriptionModel.providerInstance, transcriptionModel.model);
            const providerOptions = buildTranscriptionProviderOptions(transcriptionModel.provider, options);
            const requestStart = Date.now();
            logger.info(
                {
                    provider: transcriptionModel.provider,
                    model: transcriptionModel.model,
                    audioBytes: audioBuffer.byteLength,
                    diarize: options.diarize === true,
                    language: options.language,
                },
                "Transcription request → cloud (this upload can be slow on a degraded uplink)"
            );
            const result = await transcribe({
                model,
                audio: audioBuffer,
                ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
            });

            const processingTime = Date.now() - startTime;
            logger.info(
                {
                    provider: transcriptionModel.provider,
                    audioBytes: audioBuffer.byteLength,
                    requestMs: Date.now() - requestStart,
                },
                "Transcription request ← cloud (response received)"
            );

            const cleaned = mapSdkTranscription({
                result,
                provider: transcriptionModel.provider,
                diarize: options.diarize,
                clean: options.clean,
            });

            const transcriptionResult: TranscriptionResult = {
                text: cleaned.text,
                provider: transcriptionModel.provider,
                model: transcriptionModel.model,
                processingTime,
                segments: cleaned.segments,
                language: result.language ?? options.language,
                duration: result.durationInSeconds,
            };

            logger.info(`Transcription completed in ${pc.green((processingTime / 1000).toFixed(1))}s`);

            return transcriptionResult;
        } catch (error) {
            const processingTime = Date.now() - startTime;
            logger.error(
                { error, provider: options.provider, model: options.model, elapsedMs: processingTime },
                `Transcription failed after ${(processingTime / 1000).toFixed(1)}s (timeouts here usually mean a slow/degraded upload, not a code fault)`
            );

            // Only auto-fall-back when no provider was explicitly requested.
            // If the caller asked for a specific provider, fail loudly instead
            // of silently producing output from a different one.
            const explicitProvider = options.provider && options.provider !== "auto";

            if (!explicitProvider && options.provider !== "fallback") {
                logger.info("Trying fallback providers...");
                return await this.transcribeWithFallback(filePath, options, processingTime);
            }

            throw error;
        }
    }

    private async transcribeWithFallback(
        filePath: string,
        options: TranscriptionOptions,
        initialTime: number
    ): Promise<TranscriptionResult> {
        // Was a table of raw environment variable names. It is now just the
        // ORDER: whether a provider has a usable key is `resolveProviderApiKey`'s
        // question, and it answers it account-first with the same variables as a
        // declared fallback — so a machine with only `DEEPGRAM_API_KEY` exported
        // still gets here, and one with a configured account no longer needs it.
        const fallbackProviders = ["assemblyai", "deepgram", "gladia", "groq", "openrouter", "openai"];

        const triedProviders = new Set<string>([options.provider ?? ""]);

        for (const provider of fallbackProviders) {
            if (triedProviders.has(provider) || !(await hasUsableKey(provider))) {
                continue;
            }

            triedProviders.add(provider);

            try {
                logger.info(`Trying fallback provider: ${pc.cyan(provider)}`);

                const transcriptionModel = await this.getSpecificTranscriptionModel(
                    provider,
                    this.getDefaultModelForProvider(provider)
                );

                if (!transcriptionModel) {
                    continue;
                }

                const audioBuffer = await Bun.file(filePath).arrayBuffer();
                const model = getTranscriptionModel(transcriptionModel.providerInstance, transcriptionModel.model);
                const providerOptions = buildTranscriptionProviderOptions(transcriptionModel.provider, options);
                const result = await transcribe({
                    model,
                    audio: audioBuffer,
                    ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
                });

                const fbCleaned = mapSdkTranscription({
                    result,
                    provider,
                    diarize: options.diarize,
                    clean: options.clean,
                });

                return {
                    text: fbCleaned.text,
                    provider,
                    model: transcriptionModel.model,
                    segments: fbCleaned.segments,
                    language: result.language ?? options.language,
                    duration: result.durationInSeconds,
                    processingTime: Date.now() - initialTime,
                };
            } catch (error) {
                logger.warn(`Fallback provider ${provider} failed: ${error}`);
            }
        }

        throw new Error("All transcription providers failed");
    }

    private async selectBestTranscriptionModel(
        fileSize: number,
        preferredProvider?: string,
        preferredModel?: string
    ): Promise<{ provider: string; model: string; providerInstance: TranscriptionCapableProvider } | null> {
        // If provider and model are explicitly requested, try to use them
        if (preferredProvider && preferredModel) {
            return await this.getSpecificTranscriptionModel(preferredProvider, preferredModel);
        }

        // If only provider is specified, use it with its default model
        if (preferredProvider) {
            const model = await this.getSpecificTranscriptionModel(
                preferredProvider,
                this.getDefaultModelForProvider(preferredProvider)
            );

            if (model) {
                return model;
            }

            logger.warn(`Preferred cloud provider "${preferredProvider}" not available, falling back`);
        }

        // For large files (>25MB), prioritize providers that support large files
        if (fileSize > 25 * 1024 * 1024) {
            // AssemblyAI, Deepgram and Gladia all accept large single uploads;
            // the first one with a resolvable key wins, in that quality order.
            for (const [provider, model] of [
                ["assemblyai", "best"],
                ["deepgram", "nova-3"],
                ["gladia", "default"],
            ] as const) {
                const resolved = await this.getSpecificTranscriptionModel(provider, model);

                if (resolved) {
                    return resolved;
                }
            }
        }

        // For smaller files, prefer speed and quality
        // Priority order: Groq > OpenRouter > OpenAI
        const providers = [
            { name: "groq", model: "whisper-large-v3" },
            { name: "openrouter", model: "openai/whisper-1" },
            { name: "openai", model: "whisper-1" },
        ];

        for (const { name, model } of providers) {
            const transcriptionModel = await this.getSpecificTranscriptionModel(name, model);
            if (transcriptionModel) {
                return transcriptionModel;
            }
        }

        return null;
    }

    /**
     * Build an SDK provider instance for one vendor, or null when no key resolves.
     *
     * Every factory is called WITH an explicit key. The previous version used the
     * bare `groq` / `openai` / `deepgram` singletons, which read
     * `process.env.<VENDOR>_API_KEY` inside the SDK where nothing could audit,
     * disable or attribute them — the last place in the AI layer that still did.
     * `providerApiKeyOrNull` keeps every one of those variables working (it tries
     * configured accounts first, then the variables the plugin declares, with a
     * warning), so no machine loses transcription by upgrading.
     */
    private async getSpecificTranscriptionModel(
        providerName: string,
        modelName: string
    ): Promise<{ provider: string; model: string; providerInstance: TranscriptionCapableProvider } | null> {
        const apiKey = await providerApiKeyOrNull(providerName);

        if (!apiKey) {
            return null;
        }

        try {
            switch (providerName) {
                case "groq": {
                    const { createGroq } = await import("@ai-sdk/groq");
                    return { provider: "groq", model: modelName, providerInstance: createGroq({ apiKey }) };
                }

                case "openrouter": {
                    const { createOpenAI } = await import("@ai-sdk/openai");
                    return {
                        provider: "openrouter",
                        model: modelName,
                        providerInstance: createOpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" }),
                    };
                }

                case "openai": {
                    const { createOpenAI } = await import("@ai-sdk/openai");
                    return { provider: "openai", model: modelName, providerInstance: createOpenAI({ apiKey }) };
                }

                case "deepgram": {
                    const { createDeepgram } = await import("@ai-sdk/deepgram");
                    return {
                        provider: "deepgram",
                        model: modelName,
                        providerInstance: createDeepgram({ apiKey }) as TranscriptionCapableProvider,
                    };
                }

                case "assemblyai":
                case "gladia": {
                    // Optional dependencies — string-typed specifier so the type
                    // checker skips resolution for a package that may be absent.
                    const factoryName = providerName === "assemblyai" ? "createAssemblyAI" : "createGladia";
                    const module = (await import(`@ai-sdk/${providerName}` as string)) as Record<string, unknown>;
                    const create = module[factoryName];

                    if (typeof create !== "function") {
                        return null;
                    }

                    return {
                        provider: providerName,
                        model: modelName,
                        providerInstance: (create as (o: { apiKey: string }) => TranscriptionCapableProvider)({
                            apiKey,
                        }),
                    };
                }

                default:
                    return null;
            }
        } catch (error) {
            logger.warn(`Failed to create transcription provider ${providerName}: ${error}`);
            return null;
        }
    }

    private getDefaultModelForProvider(provider: string): string {
        switch (provider) {
            case "groq":
                return "whisper-large-v3";
            case "openrouter":
                return "openai/whisper-1";
            case "openai":
                return "whisper-1";
            case "assemblyai":
                return "best";
            case "deepgram":
                return "nova-3";
            case "gladia":
                return "default";
            default:
                return "whisper-1";
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

// Singleton instance
export const transcriptionManager = new TranscriptionManager();
