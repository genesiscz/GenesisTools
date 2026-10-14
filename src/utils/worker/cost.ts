/**
 * The token profile of one worker turn, as each backend's own stream reports it.
 *
 * Only the vocabulary lives here. Pricing is `tools ai-spend`'s (`src/ai-spend/lib/workers/`),
 * the same per-request pipeline its reports use, so a worker turn and the spend report can
 * never disagree on what the same tokens cost.
 */

/** One turn's tokens, in the classes a provider bills separately. */
export interface WorkerTokens {
    /** Input billed at the full rate: cache reads and writes are NOT in here. */
    input: number;
    cacheRead: number;
    cacheWrite: number;
    /** The one-hour share of `cacheWrite` (Claude): Anthropic bills it at 2x input, not 1.25x. */
    cacheWrite1h?: number;
    /** Output, reasoning included: every vendor bills reasoning as output. */
    output: number;
    /** The reasoning share of `output`, for the reader only; never billed a second time. */
    reasoning: number;
}

export interface WorkerUsagePart {
    /** The model that served these tokens, as the backend named it; null when it did not say. */
    model: string | null;
    tokens: WorkerTokens;
    /**
     * The part is ONE request, so its prompt length decides a context band (OpenAI above 272K,
     * xAI above 200K). An aggregate of many requests has lost the per-request lengths.
     */
    singleRequest?: boolean;
}

export type WorkerAuthMode = "subscription" | "api-key" | "unknown";

export const EMPTY_TOKENS: WorkerTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };

export function addTokens(a: WorkerTokens, b: WorkerTokens): WorkerTokens {
    const hour = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0);

    return {
        input: a.input + b.input,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        ...(hour > 0 ? { cacheWrite1h: hour } : {}),
        output: a.output + b.output,
        reasoning: a.reasoning + b.reasoning,
    };
}

export function sumPartTokens(parts: readonly WorkerUsagePart[]): WorkerTokens {
    return parts.reduce((sum, part) => addTokens(sum, part.tokens), EMPTY_TOKENS);
}
