import { CoreMLRuntime, type CoreMLRuntimeOptions } from "../local/runtimes/coreml";
import type { AIEmbeddingProvider, AIProvider, AITask, EmbeddingResult, EmbedOptions } from "../types";

const SUPPORTED_TASKS: AITask[] = ["embed"];

type AICoreMLProviderOptions = CoreMLRuntimeOptions;

/**
 * Adapter exposing the CoreML runtime as an `AIEmbeddingProvider`. The model is
 * configured at construction time via options, not per call, because loading it
 * is a native side effect the runtime instance owns.
 */
export class AICoreMLProvider implements AIProvider, AIEmbeddingProvider {
    readonly type = "coreml" as const;
    readonly dimensions: number;
    private runtime: CoreMLRuntime;

    constructor(options: AICoreMLProviderOptions) {
        this.dimensions = options.dimensions;
        this.runtime = new CoreMLRuntime(options);
    }

    async isAvailable(): Promise<boolean> {
        return this.runtime.isAvailable();
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult> {
        return this.runtime.embed(text);
    }

    async embedBatch(texts: string[], _options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return this.runtime.embedBatch(texts);
    }

    dispose(): void {
        this.runtime.dispose();
    }
}
