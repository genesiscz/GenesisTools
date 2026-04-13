import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { type AIProviderType, isCloudProvider } from "@app/utils/config/ai.types";
import { formatBytes } from "@app/utils/format";
import { ensurePackage } from "@app/utils/packages";
import { getModelsByProvider } from "./ModelRegistry";
import type { ModelEntry } from "./types";

const HF_CACHE_DIR = join(homedir(), ".cache", "huggingface", "hub");

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

    if (process.env.GROQ_API_KEY) {
        models.push(
            { id: "whisper-large-v3-turbo", name: "Groq whisper-large-v3-turbo", description: "fast" },
            { id: "whisper-large-v3", name: "Groq whisper-large-v3", description: "high quality" }
        );
    }

    if (process.env.OPENAI_API_KEY) {
        models.push({ id: "whisper-1", name: "OpenAI whisper-1", description: "reliable" });
    }

    return models;
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
        const entries = getModelsByProvider(task as Parameters<typeof getModelsByProvider>[0], "local-hf");
        return entries.map(toModelInfo);
    }

    if (isCloudProvider(provider as AIProviderType) && task === "transcribe") {
        return getCloudTranscriptionModels();
    }

    return [];
}

export class ModelManager {
    private transformersCacheDir: string | null = null;

    async listDownloaded(): Promise<Array<{ modelId: string; sizeBytes: number }>> {
        if (!existsSync(HF_CACHE_DIR)) {
            return [];
        }

        const entries = readdirSync(HF_CACHE_DIR, { withFileTypes: true });
        const models: Array<{ modelId: string; sizeBytes: number }> = [];

        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith("models--")) {
                continue;
            }

            const modelId = entry.name.replace("models--", "").replace(/--/g, "/");
            const modelPath = join(HF_CACHE_DIR, entry.name);
            const sizeBytes = this.getDirSize(modelPath);
            models.push({ modelId, sizeBytes });
        }

        return models;
    }

    async download(
        modelId: string,
        options?: { dtype?: "auto" | "fp16" | "fp32" | "q4" | "q8" | "int8" | "uint8" }
    ): Promise<void> {
        logger.info(`Downloading model: ${modelId}`);

        await ensurePackage("@huggingface/transformers", {
            label: "HuggingFace Transformers (ML models)",
        });
        const { pipeline } = await import("@huggingface/transformers");
        // Trigger a download by creating a pipeline — HF caches the model automatically
        const pipe = await pipeline("feature-extraction", modelId, {
            dtype: options?.dtype ?? "fp32",
        });
        await pipe.dispose();

        logger.info(`Model downloaded: ${modelId}`);
    }

    isDownloaded(modelId: string): boolean {
        const dirName = `models--${modelId.replace(/\//g, "--")}`;

        if (existsSync(join(HF_CACHE_DIR, dirName))) {
            return true;
        }

        if (this.transformersCacheDir) {
            const localPath = join(this.transformersCacheDir, modelId);

            if (existsSync(localPath)) {
                const files = readdirSync(localPath);
                return files.some((f) => f.endsWith(".json")) && files.length > 1;
            }
        }

        return false;
    }

    /**
     * Resolve the transformers.js cache dir (lazy, async).
     * Call once before using isDownloaded if you need transformers.js cache detection.
     */
    async resolveTransformersCache(): Promise<void> {
        if (this.transformersCacheDir) {
            return;
        }

        try {
            const { env } = await import("@huggingface/transformers");
            this.transformersCacheDir = env.cacheDir;
        } catch {
            // transformers.js not available
        }
    }

    getModelPath(modelId: string): string | null {
        const dirName = `models--${modelId.replace(/\//g, "--")}`;
        const modelPath = join(HF_CACHE_DIR, dirName);

        if (!existsSync(modelPath)) {
            return null;
        }

        return modelPath;
    }

    async cleanup(olderThanMs?: number): Promise<number> {
        if (!existsSync(HF_CACHE_DIR)) {
            return 0;
        }

        const entries = readdirSync(HF_CACHE_DIR, { withFileTypes: true });
        let removedCount = 0;

        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith("models--")) {
                continue;
            }

            const modelPath = join(HF_CACHE_DIR, entry.name);

            if (olderThanMs !== undefined) {
                const stats = statSync(modelPath);
                const age = Date.now() - stats.mtimeMs;

                if (age < olderThanMs) {
                    continue;
                }
            }

            this.removeDirRecursive(modelPath);
            removedCount++;
            logger.info(`Removed model cache: ${entry.name}`);
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

    private getDirSize(dirPath: string): number {
        let totalSize = 0;

        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);

            if (entry.isDirectory()) {
                totalSize += this.getDirSize(fullPath);
            } else {
                totalSize += statSync(fullPath).size;
            }
        }

        return totalSize;
    }

    private removeDirRecursive(dirPath: string): void {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);

            if (entry.isDirectory()) {
                this.removeDirRecursive(fullPath);
            } else {
                unlinkSync(fullPath);
            }
        }

        rmdirSync(dirPath);
    }
}
