import { rateLimitAwareDelay, retry } from "@app/utils/async";
import { AIConfig } from "../AIConfig";
import { getProviderForTask } from "../providers";
import type { AIProviderType, AITranslationProvider, TranslateOptions, TranslationResult } from "../types";

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

export class Translator {
    private provider: AITranslationProvider;

    private constructor(provider: AITranslationProvider) {
        this.provider = provider;
    }

    static async create(options?: { provider?: string; model?: string }): Promise<Translator> {
        const config = await AIConfig.load();

        if (options?.provider) {
            await config.setTask("translate", {
                provider: options.provider as AIProviderType,
                model: options.model,
            });
        }

        const provider = await getProviderForTask("translate", config);

        if (!("translate" in provider)) {
            throw new Error(`Provider "${provider.type}" does not support translation`);
        }

        return new Translator(provider as AITranslationProvider);
    }

    async translate(text: string, options: TranslateOptions): Promise<TranslationResult> {
        if (!options.from) {
            // Auto-detect source language via DarwinKit if available
            try {
                if (process.platform === "darwin") {
                    const { detectLanguage } = await import("@app/utils/macos/nlp");
                    const detected = await detectLanguage(text);
                    options = { ...options, from: detected.language };
                }
            } catch {
                // Ignore — provider will handle auto-detect or use "en" as fallback
            }
        }

        return retry(() => this.provider.translate(text, options), {
            maxAttempts: 3,
            getDelay: RETRY_DELAY,
            shouldRetry: shouldRetryTransient,
        });
    }

    dispose(): void {
        this.provider.dispose?.();
    }
}
