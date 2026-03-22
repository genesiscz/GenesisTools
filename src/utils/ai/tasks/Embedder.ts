import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import type { AIEmbeddingProvider, AIProviderType, EmbedOptions, EmbeddingResult } from "../types";

export class Embedder {
    private provider: AIEmbeddingProvider;

    private constructor(provider: AIEmbeddingProvider) {
        this.provider = provider;
    }

    static async create(options?: { provider?: string; model?: string }): Promise<Embedder> {
        const config = await AIConfig.load();

        if (options?.provider) {
            config.set("embed", { provider: options.provider as AIProviderType, model: options.model });
        }

        const provider = await getProviderForTask("embed", config);

        if (!("embed" in provider)) {
            throw new Error(`Provider "${provider.type}" does not support embedding`);
        }

        return new Embedder(provider as AIEmbeddingProvider);
    }

    get dimensions(): number {
        return this.provider.dimensions;
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        return this.provider.embed(text, options);
    }

    async embedMany(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return Promise.all(texts.map((t) => this.provider.embed(t, options)));
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
