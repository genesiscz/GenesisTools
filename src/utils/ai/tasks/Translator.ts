import { rateLimitAwareDelay, retry } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";
import { AIConfig } from "../AIConfig";
import type { AIProviderType, TranslateOptions, TranslationResult } from "../types";
import { ai } from "./facade";

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

/**
 * The `--provider`/`--model` shaped entry to translation, over `ai.translate`.
 *
 * Source-language detection stays here rather than moving into the facade: it is
 * a macOS-only NLP call that only this path ever wanted, and `ai.translate`
 * already reads a missing `from` as "auto". See `Summarizer` for why `create`
 * persists the provider instead of carrying a model ref.
 */
export class Translator {
    private constructor() {}

    static async create(options?: { provider?: string; model?: string }): Promise<Translator> {
        if (options?.provider) {
            const config = await AIConfig.load();
            await config.setTask("translate", {
                provider: options.provider as AIProviderType,
                model: options.model,
            });
        }

        return new Translator();
    }

    async translate(text: string, options: TranslateOptions): Promise<TranslationResult> {
        let effective = options;

        if (!effective.from && process.platform === "darwin") {
            try {
                const { detectLanguage } = await import("@genesiscz/utils/macos/nlp");
                const detected = await detectLanguage(text);
                effective = { ...effective, from: detected.language };
            } catch (err) {
                logger.debug({ err }, "source-language detection unavailable; translating with from=auto");
            }
        }

        return retry(() => ai.translate(text, effective), {
            maxAttempts: 3,
            getDelay: RETRY_DELAY,
            shouldRetry: shouldRetryTransient,
        });
    }

    /** @deprecated No-op: `ai.translate` binds and disposes per call. */
    dispose(): void {}
}
