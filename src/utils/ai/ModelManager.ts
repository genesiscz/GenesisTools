import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import { formatBytes } from "@app/utils/format";

const HF_CACHE_DIR = join(homedir(), ".cache", "huggingface", "hub");

export class ModelManager {
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
        return existsSync(join(HF_CACHE_DIR, dirName));
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
