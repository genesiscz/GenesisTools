import type { AIEmbeddingProvider, AITask, EmbeddingResult, EmbedOptions } from "../types";

/**
 * Deterministic, platform-independent embedding provider for tests.
 * Produces reproducible vectors from text content using hash-based generation.
 * NOT suitable for meaningful semantic similarity — only for pipeline testing.
 */
export class FakeEmbedder implements AIEmbeddingProvider {
    readonly type = "local-hf" as const;
    readonly dimensions: number;

    constructor(dimensions = 384) {
        this.dimensions = dimensions;
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }

    supports(task: AITask): boolean {
        return task === "embed";
    }

    async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult> {
        return {
            vector: this.hashToVector(text),
            dimensions: this.dimensions,
        };
    }

    async embedBatch(texts: string[], _options?: EmbedOptions): Promise<EmbeddingResult[]> {
        return texts.map((text) => ({
            vector: this.hashToVector(text),
            dimensions: this.dimensions,
        }));
    }

    dispose(): void {
        // Nothing to clean up
    }

    /** Generate a deterministic normalized Float32Array from text */
    private hashToVector(text: string): Float32Array {
        const vec = new Float32Array(this.dimensions);
        // Use a simple hash-spread: seed from text bytes, fill with pseudo-random
        let seed = 0;

        for (let i = 0; i < text.length; i++) {
            seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
        }

        for (let i = 0; i < this.dimensions; i++) {
            // xorshift32
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            vec[i] = (seed & 0xffff) / 0xffff;
        }

        // L2 normalize
        let norm = 0;

        for (let i = 0; i < this.dimensions; i++) {
            norm += vec[i] * vec[i];
        }

        norm = Math.sqrt(norm);

        if (norm > 0) {
            for (let i = 0; i < this.dimensions; i++) {
                vec[i] /= norm;
            }
        }

        return vec;
    }
}
