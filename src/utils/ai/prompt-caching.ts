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
