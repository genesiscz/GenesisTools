import type { AIEmbeddingProvider, AIProvider, AITask, EmbedOptions, EmbeddingResult } from "../types";

const SUPPORTED_TASKS: AITask[] = ["classify", "embed", "sentiment"];

export class AIDarwinKitProvider implements AIProvider, AIEmbeddingProvider {
    readonly type = "darwinkit" as const;
    readonly dimensions = 512;

    async isAvailable(): Promise<boolean> {
        return process.platform === "darwin";
    }

    supports(task: AITask): boolean {
        return SUPPORTED_TASKS.includes(task);
    }

    async detectLanguage(text: string): Promise<{ language: string; confidence: number }> {
        const { detectLanguage } = await import("@app/utils/macos/nlp");
        return detectLanguage(text);
    }

    async analyzeSentiment(text: string): Promise<{ score: number; label: string }> {
        const { analyzeSentiment } = await import("@app/utils/macos/nlp");
        return analyzeSentiment(text);
    }

    async embedText(text: string, language = "en"): Promise<{ vector: number[]; dimension: number }> {
        const { embedText } = await import("@app/utils/macos/nlp");
        return embedText(text, language);
    }

    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult> {
        const result = await this.embedText(text, options?.language ?? "en");
        return {
            vector: new Float32Array(result.vector),
            dimensions: result.dimension,
        };
    }

    async classify(
        text: string,
        categories: string[]
    ): Promise<{ category: string; confidence: number; scores: Array<{ category: string; score: number }> }> {
        const { textDistance } = await import("@app/utils/macos/nlp");

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
