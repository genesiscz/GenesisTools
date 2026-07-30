import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { ensurePackage } from "@genesiscz/utils/packages";
import type { CachedArtifact } from "../types";

/**
 * The HuggingFace weights cache is TWO independently-resolved directories and
 * they can disagree:
 *
 *   1. `~/.cache/huggingface/hub` — the hub layout (`models--org--name/`),
 *      written by the Python-side conventions and by transformers.js when it
 *      honours HF_HOME.
 *   2. `env.cacheDir` from `@huggingface/transformers` — resolved at runtime by
 *      the library itself, and where it actually writes when HF_HOME is unset.
 *      Its layout is the direct one (`org/name/`).
 *
 * Anything that lists, sizes or prunes HF weights has to look at both, which is
 * what this source is for. The locations themselves are NOT relocated: the
 * transformers.js runtime owns where it downloads to, and moving its cache out
 * from under it would just make it re-download.
 */

const HUB_CACHE_DIR = join(homedir(), ".cache", "huggingface", "hub");

function dirSize(dirPath: string): number {
    let totalSize = 0;

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
            totalSize += dirSize(fullPath);
        } else {
            totalSize += statSync(fullPath).size;
        }
    }

    return totalSize;
}

export class HfSource {
    private transformersCacheDir: string | null = null;

    constructor(private readonly hubDir: string = HUB_CACHE_DIR) {}

    /**
     * Resolve the transformers.js cache dir. Cheap to call repeatedly; the
     * library import is the expensive part and only happens once.
     */
    async resolveTransformersCache(): Promise<string | null> {
        if (this.transformersCacheDir) {
            return this.transformersCacheDir;
        }

        try {
            const { env } = await import("@huggingface/transformers");
            this.transformersCacheDir = env.cacheDir ?? null;
        } catch (err) {
            logger.debug({ err }, "[artifacts:hf] transformers.js not installed — hub cache only");
        }

        return this.transformersCacheDir;
    }

    /** Every root this source knows about, deduped, whether or not it exists yet. */
    roots(): string[] {
        const all = [this.hubDir, this.transformersCacheDir].filter((r): r is string => Boolean(r));

        return [...new Set(all)];
    }

    isCached(modelId: string): boolean {
        const dirName = `models--${modelId.replace(/\//g, "--")}`;

        if (existsSync(join(this.hubDir, dirName))) {
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

    /** Hub-layout path for a model, or null when it isn't in the hub cache. */
    cachedPath(modelId: string): string | null {
        const dirName = `models--${modelId.replace(/\//g, "--")}`;
        const modelPath = join(this.hubDir, dirName);

        if (!existsSync(modelPath)) {
            return null;
        }

        return modelPath;
    }

    /** Where a model would live if it were cached, hub layout, whether or not it is. */
    expectedPath(modelId: string): string {
        return join(this.hubDir, `models--${modelId.replace(/\//g, "--")}`);
    }

    list(): CachedArtifact[] {
        if (!existsSync(this.hubDir)) {
            return [];
        }

        const artifacts: CachedArtifact[] = [];

        for (const entry of readdirSync(this.hubDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith("models--")) {
                continue;
            }

            const path = join(this.hubDir, entry.name);
            artifacts.push({
                id: entry.name.replace("models--", "").replace(/--/g, "/"),
                source: "hf",
                root: this.hubDir,
                path,
                sizeBytes: dirSize(path),
                mtimeMs: statSync(path).mtimeMs,
            });
        }

        return artifacts;
    }

    /**
     * Pull weights into the cache by building a throwaway pipeline — HF caches
     * whatever a pipeline loads. `feature-extraction` is the historical choice
     * (this is where `ModelManager.download` sent every model regardless of
     * task), kept as-is because the only caller is the embedding-model
     * downloader in `tools indexer models`.
     */
    async download(
        modelId: string,
        options?: { dtype?: "auto" | "fp16" | "fp32" | "q4" | "q8" | "int8" | "uint8" }
    ): Promise<void> {
        logger.info(`Downloading model: ${modelId}`);

        await ensurePackage("@huggingface/transformers", {
            label: "HuggingFace Transformers (ML models)",
        });
        const { pipeline } = await import("@huggingface/transformers");
        const pipe = await pipeline("feature-extraction", modelId, {
            dtype: options?.dtype ?? "fp32",
        });
        await pipe.dispose();

        logger.info(`Model downloaded: ${modelId}`);
    }
}
