import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import type { AIProviderType, AISummarizationProvider, SummarizationResult, SummarizeOptions } from "../types";

export class Summarizer {
    private provider: AISummarizationProvider;

    private constructor(provider: AISummarizationProvider) {
        this.provider = provider;
    }

    static async create(options?: { provider?: string; model?: string }): Promise<Summarizer> {
        const config = await AIConfig.load();

        if (options?.provider) {
            await config.setTask("summarize", {
                provider: options.provider as AIProviderType,
                model: options.model,
            });
        }

        const provider = await getProviderForTask("summarize", config);

        if (!("summarize" in provider)) {
            throw new Error(`Provider "${provider.type}" does not support summarization`);
        }

        return new Summarizer(provider as AISummarizationProvider);
    }

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        return this.provider.summarize(text, options);
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
