import { rateLimitAwareDelay, retry } from "@app/utils/async";
import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import type { AIProviderType, AISummarizationProvider, SummarizationResult, SummarizeOptions } from "../types";

const RETRY_DELAY = rateLimitAwareDelay();

/** Don't retry permanent errors -- only transient/rate-limit failures are worth retrying */
function shouldRetryTransient(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);

    if (/\b(401|403|404|400)\b/.test(msg)) {
        return false;
    }

    if (/\b(invalid.api.key|unauthorized|forbidden|model.not.found)\b/i.test(msg)) {
        return false;
    }

    return true;
}

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
        return retry(() => this.provider.summarize(text, options), {
            maxAttempts: 3,
            getDelay: RETRY_DELAY,
            shouldRetry: shouldRetryTransient,
        });
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
