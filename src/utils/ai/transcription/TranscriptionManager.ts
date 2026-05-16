import { statSync } from "node:fs";
import logger from "@app/logger";
import type { TranscriptionModel } from "ai";
import { experimental_transcribe as transcribe } from "ai";
import pc from "picocolors";
import type { TranscriptionCapableProvider, TranscriptionSegment } from "../types";

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

interface SdkTranscriptionResult {
    text: string;
    segments?: ReadonlyArray<{ text: string; startSecond: number; endSecond: number }>;
    language?: string;
    durationInSeconds?: number;
}

/**
 * Rebuild sentence-level segments from a formatted transcript + word timings.
 *
 * Some providers (Deepgram via `@ai-sdk/deepgram`) only expose per-word
 * segments containing the *raw, lowercase, unpunctuated* token — the
 * smart-formatted text exists solely as `result.text`. We recover usable
 * subtitle cues by splitting `result.text` into sentences and distributing
 * them across the word timings proportionally (robust to token-count drift
 * from smart-formatting, since it never assumes a 1:1 word↔segment match).
 */
function rebuildSentenceSegments(text: string, wordSegments: TranscriptionSegment[]): TranscriptionSegment[] {
    const sentences =
        text
            .match(/[^.!?…]+[.!?…]+["')\]]*|\S[^.!?…]*$/g)
            ?.map((s) => s.trim())
            .filter(Boolean) ?? [];

    const wordCounts = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
    const totalWords = wordCounts.reduce((a, b) => a + b, 0);
    const n = wordSegments.length;

    if (sentences.length === 0 || totalWords === 0 || n === 0) {
        return wordSegments;
    }

    const out: TranscriptionSegment[] = [];
    let cum = 0;

    for (let i = 0; i < sentences.length; i++) {
        const startIdx = Math.min(n - 1, Math.floor((cum / totalWords) * n));
        cum += wordCounts[i];
        const endIdx = Math.min(n - 1, Math.max(startIdx, Math.ceil((cum / totalWords) * n) - 1));
        out.push({
            text: sentences[i],
            start: wordSegments[startIdx].start,
            end: wordSegments[endIdx].end,
        });
    }

    return out;
}

/** Map an AI SDK transcription result to our segment shape, recovering
 * sentence cues for word-level providers. */
function mapResultSegments(result: SdkTranscriptionResult): TranscriptionSegment[] | undefined {
    if (!result.segments?.length) {
        return undefined;
    }

    const segments: TranscriptionSegment[] = result.segments.map((seg) => ({
        text: seg.text,
        start: seg.startSecond,
        end: seg.endSecond,
    }));

    const singleWord = segments.filter((s) => !/\s/.test(s.text.trim())).length;

    if (result.text && segments.length > 1 && singleWord / segments.length > 0.7) {
        return rebuildSentenceSegments(result.text, segments);
    }

    return segments;
}

export interface TranscriptionOptions {
    language?: string;
    provider?: string;
    model?: string;
    timestamp?: boolean;
    verbose?: boolean;
    /** Enable speaker diarization (AssemblyAI, Deepgram). */
    diarize?: boolean;
    /** Request word-level timestamps (Whisper, Deepgram). */
    wordTimestamps?: boolean;
    /** Enable smart formatting/punctuation (Deepgram). */
    smartFormat?: boolean;
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
            const providerOptions = this.buildProviderOptions(transcriptionModel.provider, options);
            const result = await transcribe({
                model,
                audio: audioBuffer,
                ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
            });

            const processingTime = Date.now() - startTime;

            const transcriptionResult: TranscriptionResult = {
                text: result.text,
                provider: transcriptionModel.provider,
                model: transcriptionModel.model,
                processingTime,
                segments: mapResultSegments(result),
                language: result.language ?? options.language,
                duration: result.durationInSeconds,
            };

            logger.info(`Transcription completed in ${pc.green((processingTime / 1000).toFixed(1))}s`);

            return transcriptionResult;
        } catch (error) {
            const processingTime = Date.now() - startTime;
            logger.error(`Transcription failed after ${(processingTime / 1000).toFixed(1)}s: ${error}`);

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
        const fallbackProviders = [
            { env: "ASSEMBLYAI_API_KEY", provider: "assemblyai" },
            { env: "DEEPGRAM_API_KEY", provider: "deepgram" },
            { env: "GLADIA_API_KEY", provider: "gladia" },
            { env: "GROQ_API_KEY", provider: "groq" },
            { env: "OPENROUTER_API_KEY", provider: "openrouter" },
            { env: "OPENAI_API_KEY", provider: "openai" },
        ];

        const triedProviders = new Set<string>([options.provider ?? ""]);

        for (const { env, provider } of fallbackProviders) {
            if (!process.env[env] || triedProviders.has(provider)) {
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
                const providerOptions = this.buildProviderOptions(transcriptionModel.provider, options);
                const result = await transcribe({
                    model,
                    audio: audioBuffer,
                    ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
                });

                return {
                    text: result.text,
                    provider,
                    model: transcriptionModel.model,
                    segments: mapResultSegments(result),
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
            // Try AssemblyAI first (supports large files, high quality)
            if (process.env.ASSEMBLYAI_API_KEY) {
                const model = await this.getSpecificTranscriptionModel("assemblyai", "best");
                if (model) {
                    return model;
                }
            }

            // Try Deepgram (supports large files, fast)
            if (process.env.DEEPGRAM_API_KEY) {
                const model = await this.getSpecificTranscriptionModel("deepgram", "nova-3");
                if (model) {
                    return model;
                }
            }

            // Try Gladia (supports large files)
            if (process.env.GLADIA_API_KEY) {
                const model = await this.getSpecificTranscriptionModel("gladia", "default");
                if (model) {
                    return model;
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

    private async getSpecificTranscriptionModel(
        providerName: string,
        modelName: string
    ): Promise<{ provider: string; model: string; providerInstance: TranscriptionCapableProvider } | null> {
        try {
            switch (providerName) {
                case "groq": {
                    if (!process.env.GROQ_API_KEY) {
                        return null;
                    }
                    const { groq } = await import("@ai-sdk/groq");
                    return {
                        provider: "groq",
                        model: modelName,
                        providerInstance: groq,
                    };
                }

                case "openrouter": {
                    if (!process.env.OPENROUTER_API_KEY) {
                        return null;
                    }
                    const { createOpenAI } = await import("@ai-sdk/openai");
                    const openrouter = createOpenAI({
                        apiKey: process.env.OPENROUTER_API_KEY,
                        baseURL: "https://openrouter.ai/api/v1",
                    });
                    return {
                        provider: "openrouter",
                        model: modelName,
                        providerInstance: openrouter,
                    };
                }

                case "openai": {
                    if (!process.env.OPENAI_API_KEY) {
                        return null;
                    }
                    const { openai } = await import("@ai-sdk/openai");
                    return {
                        provider: "openai",
                        model: modelName,
                        providerInstance: openai,
                    };
                }

                case "assemblyai": {
                    if (!process.env.ASSEMBLYAI_API_KEY) {
                        return null;
                    }
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { assemblyai } = await import("@ai-sdk/assemblyai");
                    return {
                        provider: "assemblyai",
                        model: modelName,
                        providerInstance: assemblyai,
                    };
                }

                case "deepgram": {
                    if (!process.env.DEEPGRAM_API_KEY) {
                        return null;
                    }
                    const { deepgram } = await import("@ai-sdk/deepgram");
                    return {
                        provider: "deepgram",
                        model: modelName,
                        providerInstance: deepgram,
                    };
                }

                case "gladia": {
                    if (!process.env.GLADIA_API_KEY) {
                        return null;
                    }
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { gladia } = await import("@ai-sdk/gladia");
                    return {
                        provider: "gladia",
                        model: modelName,
                        providerInstance: gladia,
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

    /**
     * Build provider-specific options for the AI SDK `transcribe()` call.
     *
     * The AI SDK has NO top-level `language` parameter — a language hint only
     * reaches the model through `providerOptions.<providerId>.language`.
     * Passing it anywhere else is silently dropped, which makes Whisper
     * auto-detect per 30s window and hallucinate/loop on non-English audio.
     * So `language` MUST be threaded here for every provider.
     *
     * The outer key is the AI SDK *provider id*, not our internal name:
     * `openrouter` is created via `createOpenAI(...)` so its id is `openai`.
     */
    private buildProviderOptions(
        provider: string,
        options: TranscriptionOptions
    ): Record<string, Record<string, import("@ai-sdk/provider").JSONValue>> {
        const result: Record<string, Record<string, import("@ai-sdk/provider").JSONValue>> = {};
        const lang = options.language;

        if (provider === "openai" || provider === "openrouter" || provider === "groq") {
            // whisper-based; keys are camelCase per AI SDK. temperature:0 is the
            // documented anti-hallucination setting; segment timestamps power SRT/VTT.
            const opts: Record<string, import("@ai-sdk/provider").JSONValue> = {
                temperature: 0,
                timestampGranularities: ["segment"],
            };

            if (lang) {
                opts.language = lang;
            }

            // openrouter uses the openai-compatible provider instance → id "openai"
            const key = provider === "groq" ? "groq" : "openai";
            result[key] = opts;
        }

        if (provider === "deepgram") {
            const deepgramOpts: Record<string, import("@ai-sdk/provider").JSONValue> = {
                // Smart Format implies punctuation + capitalization + numerals;
                // without it Deepgram returns lowercase unpunctuated text.
                smartFormat: true,
                punctuate: true,
            };

            if (lang) {
                deepgramOpts.language = lang;
            } else {
                deepgramOpts.detectLanguage = true;
            }

            if (options.diarize) {
                deepgramOpts.diarize = true;
            }

            result.deepgram = deepgramOpts;
        }

        if (provider === "assemblyai") {
            const assemblyaiOpts: Record<string, import("@ai-sdk/provider").JSONValue> = {};

            if (lang) {
                assemblyaiOpts.languageCode = lang;
            }

            if (options.diarize) {
                assemblyaiOpts.speakerLabels = true;
            }

            if (Object.keys(assemblyaiOpts).length > 0) {
                result.assemblyai = assemblyaiOpts;
            }
        }

        return result;
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

    getAvailableProviders(): string[] {
        const providers: string[] = [];

        if (process.env.GROQ_API_KEY) {
            providers.push("groq");
        }
        if (process.env.OPENROUTER_API_KEY) {
            providers.push("openrouter");
        }
        if (process.env.OPENAI_API_KEY) {
            providers.push("openai");
        }
        if (process.env.ASSEMBLYAI_API_KEY) {
            providers.push("assemblyai");
        }
        if (process.env.DEEPGRAM_API_KEY) {
            providers.push("deepgram");
        }
        if (process.env.GLADIA_API_KEY) {
            providers.push("gladia");
        }

        return providers;
    }

    async getTranscriptionInfo(): Promise<{
        availableProviders: string[];
        supportedFormats: string[];
        maxFileSize: string;
    }> {
        return {
            availableProviders: this.getAvailableProviders(),
            supportedFormats: this.getSupportedFormats(),
            maxFileSize: "500MB",
        };
    }
}

// Singleton instance
export const transcriptionManager = new TranscriptionManager();
