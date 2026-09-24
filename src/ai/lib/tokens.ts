import { countTokens as claudeTokens } from "@anthropic-ai/tokenizer";
import { SafeJSON } from "@genesiscz/utils/json";
import { countTokens, estimateTokens } from "@genesiscz/utils/tokens";

export type TokenMethod = "estimate" | "gpt3-bpe" | "claude-local" | "claude-api";

export interface TokenCount {
    label: string;
    chars: number;
    tokens: number;
    charsPerToken: number;
    method: TokenMethod;
}

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * `claude-local` is `@anthropic-ai/tokenizer`, Anthropic's own BPE vocabulary, but
 * the Claude 1 and 2 one rather than Opus 5's: the right family, not an exact
 * figure. It is still far closer than `gpt3-bpe`, which counts roughly 40% more
 * tokens for the same source. `estimate` is the shared chars/4 heuristic. Only
 * `claude-api` reports what a model is actually billed.
 */
export const METHODS: TokenMethod[] = ["estimate", "gpt3-bpe", "claude-local", "claude-api"];

/** Message framing the endpoint adds on top of the text itself. */
export const API_ENVELOPE_TOKENS = 7;

export function countLocal(text: string, method: Exclude<TokenMethod, "claude-api">): number {
    if (method === "claude-local") {
        return claudeTokens(text);
    }

    return method === "gpt3-bpe" ? countTokens(text) : estimateTokens(text);
}

/** A stalled endpoint must end the command with an error, not hang it with no limit. */
const COUNT_TOKENS_TIMEOUT_MS = 30_000;

export async function countViaApi(text: string, model: string, apiKey: string): Promise<number> {
    const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
        signal: AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS),
        method: "POST",
        headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        body: SafeJSON.stringify({ model, messages: [{ role: "user", content: text }] }),
    }).catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") {
            throw new Error(`count_tokens did not answer within ${COUNT_TOKENS_TIMEOUT_MS / 1000} s`, { cause: err });
        }

        throw err;
    });

    if (!response.ok) {
        throw new Error(`count_tokens failed: ${response.status} ${await response.text()}`);
    }

    const parsed = (await response.json()) as { input_tokens?: number };

    if (typeof parsed.input_tokens !== "number") {
        throw new Error("count_tokens returned no input_tokens");
    }

    return parsed.input_tokens;
}

export async function countText(
    text: string,
    options: { method: TokenMethod; model: string; apiKey?: string }
): Promise<number> {
    if (options.method !== "claude-api") {
        return countLocal(text, options.method);
    }

    if (!options.apiKey) {
        throw new Error("--method claude-api needs ANTHROPIC_API_KEY; subscription accounts are not used here");
    }

    return countViaApi(text, options.model, options.apiKey);
}

export function toCount(label: string, text: string, tokens: number, method: TokenMethod): TokenCount {
    return {
        label,
        chars: text.length,
        tokens,
        charsPerToken: tokens > 0 ? Number((text.length / tokens).toFixed(2)) : 0,
        method,
    };
}
