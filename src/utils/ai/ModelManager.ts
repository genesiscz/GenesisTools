import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { formatBytes } from "@app/utils/format";
import { ensurePackage } from "@app/utils/packages";

const HF_CACHE_DIR = join(homedir(), ".cache", "huggingface", "hub");

// ============================================
// Model registry — known models per provider/task
// ============================================

export interface ModelInfo {
    id: string;
    name: string;
    description: string;
}

/** @deprecated Use ModelInfo */
export type TranscriptionModelInfo = ModelInfo;

// ── Transcription (automatic-speech-recognition) ──

const LOCAL_TRANSCRIPTION_MODELS: ModelInfo[] = [
    {
        id: "distil-whisper/distil-large-v3",
        name: "distil-large-v3",
        description: "fastest high-quality English, ~750MB — 6x faster than large-v3 (English only)",
    },
    {
        id: "onnx-community/whisper-large-v3-turbo",
        name: "whisper-large-v3-turbo",
        description: "best multilingual speed/quality, ~1.5GB (fp16 enc + q4 dec)",
    },
    {
        id: "Xenova/whisper-large-v3",
        name: "whisper-large-v3",
        description: "highest multilingual quality, ~3.1GB — slow but best accuracy",
    },
    { id: "onnx-community/whisper-small", name: "whisper-small", description: "good multilingual accuracy, ~244MB" },
    { id: "onnx-community/whisper-base", name: "whisper-base", description: "balanced speed/quality, ~145MB" },
    { id: "onnx-community/whisper-tiny", name: "whisper-tiny", description: "fastest, ~75MB" },
];

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

// ── Embeddings (feature-extraction) ──

const LOCAL_EMBEDDING_MODELS: ModelInfo[] = [
    {
        id: "Xenova/multilingual-e5-small",
        name: "multilingual-e5-small",
        description: "100 languages incl. Czech, ~117MB — recommended multilingual default",
    },
    {
        id: "nomic-ai/nomic-embed-text-v1.5",
        name: "nomic-embed-text-v1.5",
        description: "best English embedding, 10M+ downloads, ~300MB (English only)",
    },
    {
        id: "Snowflake/snowflake-arctic-embed-l-v2.0",
        name: "snowflake-arctic-embed-l-v2.0",
        description: "high-quality multilingual, explicitly supports Czech, ~500MB",
    },
    {
        id: "onnx-community/gte-multilingual-base",
        name: "gte-multilingual-base",
        description: "best multilingual MTEB score, ~305MB",
    },
    { id: "Xenova/bge-m3", name: "bge-m3", description: "top quality multilingual, dense+sparse+colbert, ~560MB" },
    {
        id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        name: "paraphrase-multilingual-MiniLM-L12-v2",
        description: "fast multilingual, 50+ languages, ~117MB",
    },
    { id: "Xenova/multilingual-e5-base", name: "multilingual-e5-base", description: "mid-size multilingual, ~278MB" },
    { id: "Xenova/multilingual-e5-large", name: "multilingual-e5-large", description: "large multilingual, ~560MB" },
    { id: "Xenova/all-MiniLM-L6-v2", name: "all-MiniLM-L6-v2", description: "English only, ~90MB — legacy" },
];

// ── Translation ──

const LOCAL_TRANSLATION_MODELS: ModelInfo[] = [
    { id: "Xenova/opus-mt-cs-en", name: "opus-mt-cs-en", description: "Czech → English, ~300MB" },
    { id: "Xenova/opus-mt-en-cs", name: "opus-mt-en-cs", description: "English → Czech, ~300MB" },
    {
        id: "Xenova/nllb-200-distilled-600M",
        name: "nllb-200-distilled-600M",
        description: "200 languages (use ces_Latn for Czech), ~2.4GB",
    },
    { id: "Xenova/m2m100_418M", name: "m2m100_418M", description: "100 languages, lighter than NLLB, ~1.8GB" },
];

// ── Summarization ──

const LOCAL_SUMMARIZATION_MODELS: ModelInfo[] = [
    {
        id: "Xenova/distilbart-cnn-6-6",
        name: "distilbart-cnn-6-6",
        description: "English only, ~910MB — translate cs→en first for Czech",
    },
];

// ── Text-to-Speech ──

const LOCAL_TTS_MODELS: ModelInfo[] = [
    {
        id: "onnx-community/Kokoro-82M-v1.0-ONNX",
        name: "Kokoro-82M",
        description: "best English TTS, ~92MB (q8) — no Czech",
    },
    {
        id: "onnx-community/chatterbox-multilingual-ONNX",
        name: "chatterbox-multilingual",
        description: "23 languages (DE/PL/RU but no Czech), ~500MB",
    },
];

// ── Task → model registry ──

const LOCAL_MODELS: Record<string, ModelInfo[]> = {
    transcribe: LOCAL_TRANSCRIPTION_MODELS,
    embed: LOCAL_EMBEDDING_MODELS,
    translate: LOCAL_TRANSLATION_MODELS,
    summarize: LOCAL_SUMMARIZATION_MODELS,
    tts: LOCAL_TTS_MODELS,
};

/**
 * Get the default (first/recommended) model for a task + provider.
 * Returns the model ID string, or undefined if no models are known.
 */
export function getDefaultModel(task: string, provider: string): string | undefined {
    return getModelsForTask(task, provider)[0]?.id;
}

/**
 * Get known models for a task + provider combination.
 * Cloud models are resolved lazily (checks env vars at call time).
 */
export function getModelsForTask(task: string, provider: string): ModelInfo[] {
    if (provider === "local-hf") {
        return LOCAL_MODELS[task] ?? [];
    }

    if (
        (provider === "cloud" ||
            provider === "openai" ||
            provider === "groq" ||
            provider === "openrouter") &&
        task === "transcribe"
    ) {
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
        // Check HuggingFace hub cache (~/.cache/huggingface/hub/models--*)
        const dirName = `models--${modelId.replace(/\//g, "--")}`;

        if (existsSync(join(HF_CACHE_DIR, dirName))) {
            return true;
        }

        // Check transformers.js local cache (node_modules/@huggingface/transformers/.cache/<org>/<model>)
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
