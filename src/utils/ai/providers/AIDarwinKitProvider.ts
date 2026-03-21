import type { AIEmbeddingProvider, AIProvider, AITask, EmbeddingResult, EmbedOptions } from "../types";

const SUPPORTED_TASKS: AITask[] = ["classify", "embed", "sentiment"];

export class AIDarwinKitProvider implements AIProvider, AIEmbeddingProvider {
    readonly type = "darwinkit" as const;
    readonly dimensions = 512;
    private nlpModule: typeof import("@app/utils/macos/nlp") | null = null;

    private async getNlp() {
        if (!this.nlpModule) {
            this.nlpModule = await import("@app/utils/macos/nlp");
        }

        return this.nlpModule;
    }

    async isAvailable(): Promise<boolean> {
        return process.platform === "darwin";
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    async detectLanguage(text: string): Promise<{ language: string; confidence: number }> {
        const nlp = await this.getNlp();
        return nlp.detectLanguage(text);
    }

    async analyzeSentiment(text: string): Promise<{ score: number; label: string }> {
        const nlp = await this.getNlp();
        return nlp.analyzeSentiment(text);
    }

    async embedText(text: string, language = "en"): Promise<{ vector: number[]; dimension: number }> {
        const nlp = await this.getNlp();
        return nlp.embedText(text, language);
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const result = await this.embedText(text, options?.language ?? "en");
        return {
            vector: new Float32Array(result.vector),
            dimensions: result.dimension,
        };
    }

    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingResult[]> {
        if (texts.length === 0) {
            return [];
        }

        const language = options?.language ?? "en";

        // Try CoreML batch endpoint first (GPU/Neural Engine accelerated)
        try {
            const nlp = await this.getNlp();

            if ("embedContextualBatch" in nlp) {
                const batchFn = nlp.embedContextualBatch as (
                    texts: string[],
                    lang: string,
                ) => Promise<Array<{ vector: number[]; dimension: number }>>;
                const batchResult = await batchFn(texts, language);
                return batchResult.map((r) => ({
                    vector: new Float32Array(r.vector),
                    dimensions: r.dimension,
                }));
            }

            if ("embedBatch" in nlp) {
                const batchFn = nlp.embedBatch as (
                    texts: string[],
                    lang: string,
                ) => Promise<Array<{ vector: number[]; dimension: number }>>;
                const batchResult = await batchFn(texts, language);
                return batchResult.map((r) => ({
                    vector: new Float32Array(r.vector),
                    dimensions: r.dimension,
                }));
            }
        } catch {
            // Batch endpoints not available or failed -- fall through to sequential
        }

        // Sequential fallback for older DarwinKit versions
        const results: EmbeddingResult[] = [];

        for (const text of texts) {
            results.push(await this.embed(text, { ...options, language }));
        }

        return results;
    }

    async classify(
        text: string,
        categories: string[]
    ): Promise<{ category: string; confidence: number; scores: Array<{ category: string; score: number }> }> {
        const { textDistance } = await this.getNlp();

        // Use embedding-based classification: embed text + each category, find closest
        const scores: Array<{ category: string; score: number }> = [];

        for (const category of categories) {
            const result = await textDistance(text, category, "en", "sentence");
            scores.push({ category, score: Math.max(0, 1 - result.distance / 2) });
        }

        scores.sort((a, b) => b.score - a.score);

        return {
            category: scores[0]?.category ?? "",
            confidence: scores[0]?.score ?? 0,
            scores,
        };
    }

    dispose(): void {
        // DarwinKit singleton is managed globally — do not close it here
    }
}
