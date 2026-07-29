import type { EmbeddingModel } from "ai";
import type { AIEmbeddingProvider } from "../types";

/**
 * Presents one of the repo's own embedding providers (transformers.js, CoreML,
 * DarwinKit, Ollama) as an ai-sdk embedding model.
 *
 * The local providers predate the ai-sdk shape and speak `embed(text)` /
 * `embedBatch(texts)`. Rather than rewrite them here — that is the Phase 6
 * restructure — this adapter lets a local provider sit behind the same
 * `ProviderBinding.embedding()` call as a cloud one, so consumers stop caring
 * where a vector came from.
 */
export function toEmbeddingModel({
    provider,
    providerId,
    modelId,
}: {
    provider: AIEmbeddingProvider;
    providerId: string;
    modelId: string;
}): EmbeddingModel {
    return {
        specificationVersion: "v3",
        provider: providerId,
        modelId,
        // Local runtimes have no request limit; they loop in-process.
        maxEmbeddingsPerCall: Number.POSITIVE_INFINITY,
        // One model instance holds one native session, so parallel calls would
        // contend on it rather than go faster.
        supportsParallelCalls: false,

        async doEmbed({ values }) {
            const results = provider.embedBatch
                ? await provider.embedBatch(values, { model: modelId })
                : await Promise.all(values.map((value) => provider.embed(value, { model: modelId })));

            return {
                embeddings: results.map((result) => Array.from(result.vector)),
                warnings: [],
            };
        },
    };
}
