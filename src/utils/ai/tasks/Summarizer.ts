import { rateLimitAwareDelay, retry } from "@genesiscz/utils/async";
import { AIConfig } from "../AIConfig";
import type { AIProviderType, SummarizationResult, SummarizeOptions } from "../types";
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
 * The `--provider`/`--model` shaped entry to summarization, over `ai.summarize`.
 *
 * It used to reach `getProviderForTask` and then whichever `summarize()` that
 * provider implemented, so the prompt behind a summary depended on who answered
 * — the duplicate path this phase removes. What it still adds over calling the
 * facade directly is the CLI contract: persisting the chosen provider as the
 * task default, and retrying transient failures.
 *
 * `create` deliberately keeps NO model ref of its own. `setTask` writes
 * `defaults.task.summarize`, and resolution reads that rung, so the persisted
 * choice is honoured without this class restating it — and a lone `--provider`
 * never has to be spelled as a ref, which would parse as a bare MODEL id
 * (see `taskModelRef`'s note in task-models.ts).
 */
export class Summarizer {
    private constructor() {}

    static async create(options?: { provider?: string; model?: string }): Promise<Summarizer> {
        if (options?.provider) {
            const config = await AIConfig.load();
            await config.setTask("summarize", {
                provider: options.provider as AIProviderType,
                model: options.model,
            });
        }

        return new Summarizer();
    }

    async summarize(text: string, options?: SummarizeOptions): Promise<SummarizationResult> {
        return retry(() => ai.summarize(text, options), {
            maxAttempts: 3,
            getDelay: RETRY_DELAY,
            shouldRetry: shouldRetryTransient,
        });
    }

    /** @deprecated No-op: `ai.summarize` binds and disposes per call. */
    dispose(): void {}
}
