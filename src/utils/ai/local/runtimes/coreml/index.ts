import { logger } from "@genesiscz/utils/logger";
import type { EmbeddingResult } from "../../../types";

// CoreML namespace types — implemented in DarwinKit Swift binary but not yet in published @genesiscz/darwinkit types
interface CoreMLEmbedResult {
    vector: number[];
    dimensions: number;
}

interface CoreMLEmbedBatchResult {
    vectors: number[][];
    dimensions: number;
    count: number;
}

interface CoreMLNamespace {
    loadModel(params: { id: string; path: string; compute_units?: string; warm_up?: boolean }): Promise<void>;
    loadContextual(params: { id: string; language?: string }): Promise<void>;
    embed(params: { model_id: string; text: string }): Promise<CoreMLEmbedResult>;
    embedBatch(params: { model_id: string; texts: string[] }): Promise<CoreMLEmbedBatchResult>;
    contextualEmbed(params: { model_id: string; text: string }): Promise<CoreMLEmbedResult>;
    embedContextualBatch(params: { model_id: string; texts: string[] }): Promise<CoreMLEmbedBatchResult>;
    unloadModel(params: { id: string }): Promise<void>;
}

interface DarwinKitWithCoreML {
    coreml: CoreMLNamespace;
}

interface CoreMLBaseOptions {
    modelId: string;
    dimensions: number;
}

export interface CoreMLCustomModelOptions extends CoreMLBaseOptions {
    contextual?: false;
    modelPath: string;
    computeUnits?: "all" | "cpuAndGPU" | "cpuOnly" | "cpuAndNeuralEngine";
}

export interface CoreMLContextualOptions extends CoreMLBaseOptions {
    contextual: true;
    language?: string;
}

export type CoreMLRuntimeOptions = CoreMLCustomModelOptions | CoreMLContextualOptions;

/** Injected in tests so the load/embed paths run without the native binary. */
export type DarwinKitLoader = () => Promise<DarwinKitWithCoreML>;

const loadDarwinKit: DarwinKitLoader = async () => {
    const { getDarwinKit } = await import("@genesiscz/utils/macos/darwinkit");

    return getDarwinKit() as unknown as DarwinKitWithCoreML;
};

/**
 * CoreML inference through the DarwinKit Swift binary. One runtime instance
 * holds one loaded model — loading is a native side effect keyed by model id,
 * so the instance also owns unloading it.
 *
 * Two model shapes: a custom `.mlmodelc` on disk, or Apple's built-in
 * contextual embedder (no artifact to download, language-scoped).
 */
export class CoreMLRuntime {
    readonly id = "coreml" as const;

    private loaded = false;
    private loadingPromise: Promise<DarwinKitWithCoreML> | null = null;
    private darwinkit: DarwinKitWithCoreML | null = null;

    constructor(
        private readonly options: CoreMLRuntimeOptions,
        private readonly loader: DarwinKitLoader = loadDarwinKit
    ) {}

    async isAvailable(): Promise<boolean> {
        return process.platform === "darwin";
    }

    async embed(text: string): Promise<EmbeddingResult> {
        const dk = await this.ensureLoaded();

        if (this.options.contextual) {
            const result = await dk.coreml.contextualEmbed({
                model_id: this.options.modelId,
                text,
            });

            return {
                vector: new Float32Array(result.vector),
                dimensions: result.dimensions,
            };
        }

        const result = await dk.coreml.embed({
            model_id: this.options.modelId,
            text,
        });

        return {
            vector: new Float32Array(result.vector),
            dimensions: result.dimensions,
        };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const dk = await this.ensureLoaded();

        // Try native GPU-batched CoreML endpoints first (DarwinKit v0.3.0+)
        try {
            if (this.options.contextual) {
                const result = await dk.coreml.embedContextualBatch({
                    model_id: this.options.modelId,
                    texts,
                });

                return result.vectors.map((v) => ({
                    vector: new Float32Array(v),
                    dimensions: result.dimensions,
                }));
            }

            const result = await dk.coreml.embedBatch({
                model_id: this.options.modelId,
                texts,
            });

            return result.vectors.map((v) => ({
                vector: new Float32Array(v),
                dimensions: result.dimensions,
            }));
        } catch (err) {
            // Batch endpoints not available — fall back to sequential
            logger.debug({ err, modelId: this.options.modelId }, "[coreml] batch endpoint unavailable");
        }

        // Sequential fallback for older DarwinKit versions
        const results: EmbeddingResult[] = [];

        for (const text of texts) {
            results.push(await this.embed(text));
        }

        return results;
    }

    private ensureLoaded(): Promise<DarwinKitWithCoreML> {
        if (this.darwinkit && this.loaded) {
            return Promise.resolve(this.darwinkit);
        }

        if (this.loadingPromise) {
            return this.loadingPromise;
        }

        this.loadingPromise = this.loadModel().finally(() => {
            this.loadingPromise = null;
        });

        return this.loadingPromise;
    }

    private async loadModel(): Promise<DarwinKitWithCoreML> {
        this.darwinkit = await this.loader();

        if (this.options.contextual) {
            await this.darwinkit.coreml.loadContextual({
                id: this.options.modelId,
                language: this.options.language ?? "en",
            });
        } else {
            await this.darwinkit.coreml.loadModel({
                id: this.options.modelId,
                path: this.options.modelPath,
                compute_units: this.options.computeUnits ?? "all",
                warm_up: true,
            });
        }

        this.loaded = true;
        return this.darwinkit;
    }

    dispose(): void {
        if (this.darwinkit && this.loaded) {
            this.darwinkit.coreml
                .unloadModel({ id: this.options.modelId })
                .catch((err) =>
                    logger.debug({ err, path: this.options.modelId }, "[cleanup] best-effort resource cleanup failed")
                );
        }
    }
}
