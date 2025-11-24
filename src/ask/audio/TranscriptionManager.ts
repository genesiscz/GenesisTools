import { experimental_transcribe as transcribe } from "ai";
import { statSync } from "node:fs";
import type { ProviderV1 } from "@ai-sdk/provider";
import chalk from "chalk";
import logger from "@app/logger";
import { modelSelector } from "@ask/providers/ModelSelector";

export interface TranscriptionOptions {
    language?: string;
    provider?: string;
    model?: string;
    timestamp?: boolean;
    verbose?: boolean;
}

export interface TranscriptionResult {
    text: string;
    provider: string;
    model: string;
    duration?: number;
    confidence?: number;
    cost?: number;
    processingTime: number;
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
            logger.info(`Transcribing ${chalk.cyan(filePath)} (${this.formatFileSize(fileSize)})`);

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
                `Using ${chalk.green(transcriptionModel.provider)} with model ${chalk.yellow(transcriptionModel.model)}`
            );

            // Read audio file
            const audioBuffer = await Bun.file(filePath).arrayBuffer();

            // Perform transcription
            const model = transcriptionModel.providerInstance(transcriptionModel.model);
            const result = await transcribe({
                model,
                audio: audioBuffer,
                ...(options.language && { language: options.language }),
            });

            const processingTime = Date.now() - startTime;

            const transcriptionResult: TranscriptionResult = {
                text: result.text,
                provider: transcriptionModel.provider,
                model: transcriptionModel.model,
                processingTime,
            };

            // Note: result from experimental_transcribe doesn't have duration property
            // Duration would need to be calculated separately if needed

            logger.info(`Transcription completed in ${chalk.green((processingTime / 1000).toFixed(1))}s`);

            return transcriptionResult;
        } catch (error) {
            const processingTime = Date.now() - startTime;
            logger.error(`Transcription failed after ${(processingTime / 1000).toFixed(1)}s: ${error}`);

            // Try fallback providers if primary failed
            if (options.provider !== "fallback") {
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

        for (const { env, provider } of fallbackProviders) {
            if (process.env[env] && provider !== options.provider) {
                try {
                    logger.info(`Trying fallback provider: ${chalk.cyan(provider)}`);
                    const result = await this.transcribeAudio(filePath, {
                        ...options,
                        provider,
                    });

                    // Add fallback information
                    return {
                        ...result,
                        processingTime: Date.now() - initialTime,
                    };
                } catch (error) {
                    logger.warn(`Fallback provider ${provider} failed: ${error}`);
                    continue;
                }
            }
        }

        throw new Error("All transcription providers failed");
    }

    private async selectBestTranscriptionModel(
        fileSize: number,
        preferredProvider?: string,
        preferredModel?: string
    ): Promise<{ provider: string; model: string; providerInstance: ProviderV1 } | null> {
        // If provider and model are explicitly requested, try to use them
        if (preferredProvider && preferredModel) {
            return await this.getSpecificTranscriptionModel(preferredProvider, preferredModel);
        }

        // For large files (>25MB), prioritize providers that support large files
        if (fileSize > 25 * 1024 * 1024) {
            // Try AssemblyAI first (supports large files, high quality)
            if (process.env.ASSEMBLYAI_API_KEY) {
                const model = await this.getSpecificTranscriptionModel("assemblyai", "best");
                if (model) return model;
            }

            // Try Deepgram (supports large files, fast)
            if (process.env.DEEPGRAM_API_KEY) {
                const model = await this.getSpecificTranscriptionModel("deepgram", "nova-3");
                if (model) return model;
            }

            // Try Gladia (supports large files)
            if (process.env.GLADIA_API_KEY) {
                const model = await this.getSpecificTranscriptionModel("gladia", "default");
                if (model) return model;
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
    ): Promise<{ provider: string; model: string; providerInstance: ProviderV1 } | null> {
        try {
            switch (providerName) {
                case "groq": {
                    if (!process.env.GROQ_API_KEY) return null;
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { groq } = await import("@ai-sdk/groq");
                    return {
                        provider: "groq",
                        model: modelName,
                        providerInstance: groq,
                    };
                }

                case "openrouter": {
                    if (!process.env.OPENROUTER_API_KEY) return null;
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
                    if (!process.env.OPENAI_API_KEY) return null;
                    const { openai } = await import("@ai-sdk/openai");
                    return {
                        provider: "openai",
                        model: modelName,
                        providerInstance: openai,
                    };
                }

                case "assemblyai": {
                    if (!process.env.ASSEMBLYAI_API_KEY) return null;
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { assemblyai } = await import("@ai-sdk/assemblyai");
                    return {
                        provider: "assemblyai",
                        model: modelName,
                        providerInstance: assemblyai,
                    };
                }

                case "deepgram": {
                    if (!process.env.DEEPGRAM_API_KEY) return null;
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { deepgram } = await import("@ai-sdk/deepgram");
                    return {
                        provider: "deepgram",
                        model: modelName,
                        providerInstance: deepgram,
                    };
                }

                case "gladia": {
                    if (!process.env.GLADIA_API_KEY) return null;
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

        if (process.env.GROQ_API_KEY) providers.push("groq");
        if (process.env.OPENROUTER_API_KEY) providers.push("openrouter");
        if (process.env.OPENAI_API_KEY) providers.push("openai");
        if (process.env.ASSEMBLYAI_API_KEY) providers.push("assemblyai");
        if (process.env.DEEPGRAM_API_KEY) providers.push("deepgram");
        if (process.env.GLADIA_API_KEY) providers.push("gladia");

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
