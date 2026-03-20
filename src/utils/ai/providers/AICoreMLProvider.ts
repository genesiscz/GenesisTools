import type { AIEmbeddingProvider, AIProvider, AITask, EmbeddingResult, EmbedOptions } from "../types";

const SUPPORTED_TASKS: AITask[] = ["embed"];

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
    private darwinkit: ReturnType<typeof import("@app/utils/macos/darwinkit").getDarwinKit> | null = null;

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

    private async ensureLoaded() {
        if (this.darwinkit && this.loaded) {
            return this.darwinkit;
        }

        const { getDarwinKit } = await import("@app/utils/macos/darwinkit");
        this.darwinkit = getDarwinKit();

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
                .catch(() => {});
        }
    }
}
