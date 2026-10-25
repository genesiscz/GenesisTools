/**
 * Prompt-cache arithmetic shared by `tools ai-proxy` (sessions, stats, calls), `tools ai-spend` and session-analyzer.
 *
 * One definition of the hit rate everywhere: cache read / (uncached input + cache read + cache write), the
 * session-analyzer definition (GenesisClaude `user/skills/session-analyzer/SKILL.md`, "Cache hit"). Two usage
 * conventions feed it:
 * - Anthropic-shaped (`input_tokens` or `prompt_tokens` plus `cache_read_input_tokens`, `cache_creation_input_tokens`):
 *   the cache counts sit OUTSIDE the input count.
 * - OpenAI-shaped (`prompt_tokens` with `cached_prompt_tokens` from `prompt_tokens_details.cached_tokens` or
 *   Responses `input_tokens_details.cached_tokens`): the cached count is a PART of the prompt count.
 */

/** The prompt-side fields of an ai-proxy usage row (`TokenUsage`), in either convention. */
export interface PromptTokenFields {
    prompt_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cached_prompt_tokens?: number;
}

export interface PromptTokenSplit {
    /** Input the upstream processed in full. */
    uncached: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Split one usage row into uncached input, cache read and cache write, whichever convention it uses. */
export function splitPromptTokens(usage: PromptTokenFields | undefined): PromptTokenSplit {
    const prompt = usage?.prompt_tokens ?? 0;

    if (usage?.cache_read_input_tokens !== undefined || usage?.cache_creation_input_tokens !== undefined) {
        return {
            uncached: prompt,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
        };
    }

    const cached = Math.min(usage?.cached_prompt_tokens ?? 0, prompt);
    return { uncached: prompt - cached, cacheRead: cached, cacheWrite: 0 };
}

/** All input the request carried: uncached + cache read + cache write (session-analyzer's `ctxOf`). */
export function contextTokens(split: PromptTokenSplit): number {
    return split.uncached + split.cacheRead + split.cacheWrite;
}

/** Cache read as a percent of all input; undefined when there was no input at all. */
export function hitPercent(split: PromptTokenSplit): number | undefined {
    const total = contextTokens(split);
    return total > 0 ? (split.cacheRead / total) * 100 : undefined;
}
