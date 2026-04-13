import { rateLimitAwareDelay, retry } from "@app/utils/async";
import { AIConfig } from "../AIConfig";
import { findModel } from "../ModelRegistry";
import { getProviderForTask } from "../providers";
import type { AIEmbeddingProvider, AIProviderType, EmbeddingResult, EmbedOptions } from "../types";

const RETRY_DELAY = rateLimitAwareDelay();

/** Don't retry permanent errors — only transient/rate-limit failures are worth retrying */
function shouldRetryEmbedding(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    // Permanent HTTP errors: bad credentials, bad model, invalid input
    if (/\b(401|403|404|400)\b/.test(msg)) {
        return false;
    }

    // Permanent provider errors
    if (/\b(invalid.api.key|unauthorized|forbidden|model.not.found)\b/i.test(msg)) {
        return false;
    }

    return true;
}

export class Embedder {
    private provider: AIEmbeddingProvider;
    private modelId?: string;

    private constructor(provider: AIEmbeddingProvider, modelId?: string) {
        this.provider = provider;
        this.modelId = modelId;
    }

    static async create(options?: { provider?: string; model?: string; persist?: boolean }): Promise<Embedder> {
        const config = await AIConfig.load();

        if (options?.provider) {
            // User explicitly chose a provider — fail if unavailable, don't silently fall back
            const { getProvider } = await import("../providers/index");
            const explicit = getProvider(options.provider as AIProviderType);

            if (!explicit.supports("embed")) {
                throw new Error(`Provider "${options.provider}" does not support embedding`);
            }

            if (!(await explicit.isAvailable())) {
                throw new Error(
                    `Provider "${options.provider}" is not available. ` +
                        (options.provider === "ollama"
                            ? "Is Ollama running? Start it with: ollama serve"
                            : options.provider === "coreml"
                              ? "CoreML requires macOS 14+"
                              : `Check that ${options.provider} is properly configured.`)
                );
            }

            // For Ollama: verify the model is available (caller should pull first via CLI prompt)
            if (options.provider === "ollama" && options.model) {
                const ollamaProvider = explicit as import("../providers/AIOllamaProvider").AIOllamaProvider;

                if (!(await ollamaProvider.hasModel(options.model))) {
                    throw new Error(
                        `Ollama model "${options.model}" is not pulled.\n` + `Run: ollama pull ${options.model}`
                    );
                }
            }

            if (options.persist) {
                await config.setTask("embed", {
                    provider: options.provider as AIProviderType,
                    model: options.model,
                });
            }

            return new Embedder(explicit as AIEmbeddingProvider, options.model);
        }

        const provider = await getProviderForTask("embed", config);

        if (!("embed" in provider)) {
            throw new Error(`Provider "${provider.type}" does not support embedding`);
        }

        const taskConfig = config.getTask("embed");
        return new Embedder(provider as AIEmbeddingProvider, taskConfig?.model);
    }

    get dimensions(): number {
        if (this.modelId) {
            const entry = findModel(this.modelId);

            if (entry?.dimensions) {
                return entry.dimensions;
            }
        }

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
            shouldRetry: shouldRetryEmbedding,
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
                shouldRetry: shouldRetryEmbedding,
            });
        }

        // Sequential fallback to avoid thundering herd after batch failure
        const results: EmbeddingResult[] = [];

        for (const t of texts) {
            const result = await retry(() => this.provider.embed(t, options), {
                maxAttempts: 3,
                getDelay: RETRY_DELAY,
                shouldRetry: shouldRetryEmbedding,
            });
            results.push(result);
        }

        return results;
    }

    /** @deprecated Use embedBatch() instead */
    async embedMany(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return this.embedBatch(texts, options);
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
