import type { AIEmbeddingProvider, AIProvider, AITask, EmbeddingResult, EmbedOptions } from "../types";

const SUPPORTED_TASKS: AITask[] = ["embed"];

// CoreML namespace types — implemented in DarwinKit Swift binary but not yet in published @genesiscz/darwinkit types
interface CoreMLEmbedResult {
    vector: number[];
    dimensions: number;
}

interface CoreMLNamespace {
    loadModel(params: { id: string; path: string; compute_units?: string; warm_up?: boolean }): Promise<void>;
    loadContextual(params: { id: string; language?: string }): Promise<void>;
    embed(params: { model_id: string; text: string }): Promise<CoreMLEmbedResult>;
    contextualEmbed(params: { model_id: string; text: string }): Promise<CoreMLEmbedResult>;
    unloadModel(params: { id: string }): Promise<void>;
}

interface DarwinKitWithCoreML {
    coreml: CoreMLNamespace;
}

interface AICoreMLProviderOptions {
    /** User-assigned model ID for DarwinKit CoreML model cache */
    modelId: string;
    /** Path to .mlpackage / .mlmodelc or HuggingFace model directory */
    modelPath: string;
    /** Embedding dimensions (e.g. 384, 512, 768) */
    dimensions: number;
    /** Whether to use NLContextualEmbedding instead of custom model */
    contextual?: boolean;
    /** Language for NLContextualEmbedding (default: "en") */
    language?: string;
    /** CoreML compute units */
    computeUnits?: "all" | "cpuAndGPU" | "cpuOnly" | "cpuAndNeuralEngine";
}

export class AICoreMLProvider implements AIProvider, AIEmbeddingProvider {
    readonly type = "coreml" as const;
    readonly dimensions: number;
    private options: AICoreMLProviderOptions;
    private loaded = false;
    private loadingPromise: Promise<DarwinKitWithCoreML> | null = null;
    private darwinkit: DarwinKitWithCoreML | null = null;

    constructor(options: AICoreMLProviderOptions) {
        this.options = options;
        this.dimensions = options.dimensions;
    }

    async isAvailable(): Promise<boolean> {
        return process.platform === "darwin";
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    // Model is configured at construction time via options, not per-call
    async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult> {
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

    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        const results: EmbeddingResult[] = [];

        for (const text of texts) {
            results.push(await this.embed(text, options));
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
        const { getDarwinKit } = await import("@app/utils/macos/darwinkit");
        this.darwinkit = getDarwinKit() as unknown as DarwinKitWithCoreML;

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
            this.darwinkit.coreml.unloadModel({ id: this.options.modelId }).catch(() => {});
        }
    }
}
