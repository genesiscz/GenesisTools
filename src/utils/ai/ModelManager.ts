import { rm } from "node:fs/promises";
import { type AIProviderType, isCloudProvider } from "@genesiscz/utils/config/ai.types";
import { env } from "@genesiscz/utils/env";
import { formatBytes } from "@genesiscz/utils/format";
import { logger } from "@genesiscz/utils/logger";
import { HfSource } from "./local/artifacts";
import { byTaskAndProvider } from "./local/descriptors";
import type { ModelEntry } from "./types";

export interface ModelInfo {
    id: string;
    name: string;
    description: string;
}

/** @deprecated Use ModelInfo */
export type TranscriptionModelInfo = ModelInfo;

function toModelInfo(entry: ModelEntry): ModelInfo {
    return { id: entry.id, name: entry.name, description: entry.description };
}

function getCloudTranscriptionModels(): ModelInfo[] {
    const models: ModelInfo[] = [];

    if (env.ai.groq.getKey()) {
        models.push(
            { id: "whisper-large-v3-turbo", name: "Groq whisper-large-v3-turbo", description: "fast" },
            { id: "whisper-large-v3", name: "Groq whisper-large-v3", description: "high quality" }
        );
    }

    if (env.ai.openai.getKey()) {
        models.push({ id: "whisper-1", name: "OpenAI whisper-1", description: "reliable" });
    }

    return models;
}

function getXAITranscriptionModels(): ModelInfo[] {
    if (!env.x.getApiKey()) {
        return [];
    }

    return [{ id: "grok-stt", name: "xAI STT", description: "xAI's hosted STT (voice-think)" }];
}

/**
 * Get the default (first/recommended) model for a task + provider.
 * Returns the model ID string, or undefined if no models are known.
 */
export function getDefaultModel(task: string, provider: string): string | undefined {
    return getModelsForTask(task, provider)[0]?.id;
}

/**
 * Get known models for a task + provider combination.
 * Cloud transcription models are resolved lazily (checks env vars at call time).
 */
export function getModelsForTask(task: string, provider: string): ModelInfo[] {
    if (provider === "local-hf") {
        const entries = byTaskAndProvider(task as Parameters<typeof byTaskAndProvider>[0], "local-hf");
        return entries.map(toModelInfo);
    }

    if (provider === "xai" && task === "transcribe") {
        return getXAITranscriptionModels();
    }

    if (isCloudProvider(provider as AIProviderType) && task === "transcribe") {
        return getCloudTranscriptionModels();
    }

    return [];
}

/**
 * @deprecated Thin facade over `./local/artifacts`. The HuggingFace cache logic
 * it used to own now lives in `HfSource` (which reconciles the hub directory
 * with transformers.js's own `env.cacheDir`) and `ArtifactStore`; new code
 * should use those directly.
 */
export class ModelManager {
    private readonly hf = new HfSource();

    async listDownloaded(): Promise<Array<{ modelId: string; sizeBytes: number }>> {
        return this.hf.list().map((a) => ({ modelId: a.id, sizeBytes: a.sizeBytes }));
    }

    async download(
        modelId: string,
        options?: { dtype?: "auto" | "fp16" | "fp32" | "q4" | "q8" | "int8" | "uint8" }
    ): Promise<void> {
        return this.hf.download(modelId, options);
    }

    isDownloaded(modelId: string): boolean {
        return this.hf.isCached(modelId);
    }

    /**
     * Resolve the transformers.js cache dir (lazy, async).
     * Call once before using isDownloaded if you need transformers.js cache detection.
     */
    async resolveTransformersCache(): Promise<void> {
        await this.hf.resolveTransformersCache();
    }

    getModelPath(modelId: string): string | null {
        return this.hf.cachedPath(modelId);
    }

    /** Returns how many cached models were removed. */
    async cleanup(olderThanMs?: number): Promise<number> {
        const cached = this.hf.list();
        const cutoff = olderThanMs === undefined ? null : Date.now() - olderThanMs;
        let removedCount = 0;

        for (const artifact of cached) {
            if (cutoff !== null && artifact.mtimeMs >= cutoff) {
                continue;
            }

            await rm(artifact.path, { recursive: true, force: true });
            removedCount++;
            logger.info(`Removed model cache: ${artifact.id}`);
        }

        return removedCount;
    }

    async getCacheSize(): Promise<{ totalBytes: number; formatted: string; modelCount: number }> {
        const models = await this.listDownloaded();
        const totalBytes = models.reduce((sum, m) => sum + m.sizeBytes, 0);

        return {
            totalBytes,
            formatted: formatBytes(totalBytes),
            modelCount: models.length,
        };
    }
}
