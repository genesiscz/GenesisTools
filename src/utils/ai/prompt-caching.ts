import type { SharedV2ProviderOptions } from "@ai-sdk/provider";

/**
 * Build providerOptions that request Anthropic ephemeral prompt caching.
 *
 * When passed to `streamText`/`generateText`, the @ai-sdk/anthropic provider
 * forwards `cacheControl` hints to Claude. Caching applies to the system prompt
 * and tool catalogs; cache hits give ~90% input-token cost reduction with a
 * 5-minute TTL. No-op for non-Anthropic models.
 *
 * Anthropic minimum cache-block size is 1 024 tokens — smaller blocks emit a
 * warning but do not error.
 */
export function anthropicCacheControl(): SharedV2ProviderOptions {
    return {
        anthropic: {
            cacheControl: { type: "ephemeral" },
        },
    };
}

/**
 * Build providerOptions for WHAM (OpenAI Codex subscription) requests.
 * WHAM's Responses API requires `store: false` and a non-empty `instructions` field.
 */
export function whamProviderOptions(): SharedV2ProviderOptions {
    return {
        openai: {
            store: false,
            instructions: "You are a helpful assistant.",
        },
    };
}

/**
 * Build providerOptions for the given provider type.
 * Merges Anthropic cache control and WHAM options as needed.
 */
export function buildProviderOptions(providerType?: string): SharedV2ProviderOptions {
    if (providerType === "openai-sub") {
        return {
            ...anthropicCacheControl(),
            ...whamProviderOptions(),
        };
    }

    // OpenRouter reports its own charge for the exact route it took, but only when
    // asked: the SDK sends `include_usage` in `strict` compatibility mode or when
    // `usage.include` is true, and `createOpenRouter` defaults to `compatible`.
    // The plugin sets it at bind time; this covers the call sites that reach the
    // model some other way. Per-account provider routing cannot live here — this
    // function is pure and has no account.
    if (providerType === "openrouter") {
        return {
            ...anthropicCacheControl(),
            openrouter: { usage: { include: true } },
        };
    }

    return anthropicCacheControl();
}
