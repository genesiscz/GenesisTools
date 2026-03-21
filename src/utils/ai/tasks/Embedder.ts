import { rateLimitAwareDelay, retry } from "@app/utils/async";
import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import type { AIEmbeddingProvider, AIProviderType, EmbeddingResult, EmbedOptions } from "../types";

const RETRY_DELAY = rateLimitAwareDelay();

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

    /** Whether the underlying provider supports native batch embedding */
    get supportsBatch(): boolean {
        return typeof this.provider.embedBatch === "function";
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        return retry(() => this.provider.embed(text, options), {
            maxAttempts: 3,
            getDelay: RETRY_DELAY,
        });
    }

    /**
     * Embed multiple texts, using native batch if the provider supports it,
     * otherwise falling back to Promise.all over individual embed() calls.
     */
    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        if (this.provider.embedBatch) {
            return retry(() => this.provider.embedBatch!(texts, options), {
                maxAttempts: 3,
                getDelay: RETRY_DELAY,
            });
        }

        return Promise.all(
            texts.map((t) =>
                retry(() => this.provider.embed(t, options), {
                    maxAttempts: 3,
                    getDelay: RETRY_DELAY,
                })
            )
        );
    }

    /** @deprecated Use embedBatch() instead */
    async embedMany(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return this.embedBatch(texts, options);
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
