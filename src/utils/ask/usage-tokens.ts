import type { LanguageModelUsage } from "ai";

/**
 * Reading token counts off an ai-sdk usage object.
 *
 * These lived in `src/ask/utils/helpers.ts`, which meant every cost calculation
 * outside ask — youtube's usage recorder, the shared cost math — had to reach
 * into the ask tool for them. They describe the SDK's usage shape, not anything
 * about ask, so they belong next to the other shared ask-vocabulary types.
 */

/**
 * Flat usage shape written by ai@5 (persisted sessions, ask's own message
 * records). ai@7 moved cached tokens into `inputTokenDetails`.
 */
export interface LegacyFlatUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
}

/**
 * Cached (prompt-cache read) input tokens from a v7 usage object, falling
 * back to the flat ai@5 field for data persisted before the upgrade.
 */
export function usageCacheReadTokens(usage?: LanguageModelUsage | LegacyFlatUsage): number {
    if (!usage) {
        return 0;
    }

    if ("inputTokenDetails" in usage) {
        return usage.inputTokenDetails?.cacheReadTokens ?? 0;
    }

    return usage.cachedInputTokens ?? 0;
}

/** Cache-write (prompt-cache creation) input tokens; ai@5 had no such field. */
export function usageCacheWriteTokens(usage?: LanguageModelUsage | LegacyFlatUsage): number {
    if (!usage) {
        return 0;
    }

    if ("inputTokenDetails" in usage) {
        return usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    }

    return 0;
}

/**
 * Non-cached input tokens — the ones billed at the full input rate.
 *
 * IMPORTANT: in ai@7 the `@ai-sdk/anthropic@4` provider maps top-level
 * `inputTokens` to `input_tokens + cacheCreation + cacheRead` (it INCLUDES
 * cache tokens), whereas ai@5 excluded them. Billing base input on
 * `inputTokens` would double-charge cache tokens (once at full rate here, once
 * at the cache rate). Always price the base input on this value, then add
 * cache-read / cache-write costs separately. For legacy flat usage (ai@5),
 * `inputTokens` already excluded cache, so it is returned as-is.
 */
export function usageInputNoCacheTokens(usage?: LanguageModelUsage | LegacyFlatUsage): number {
    if (!usage) {
        return 0;
    }

    if ("inputTokenDetails" in usage) {
        const noCache = usage.inputTokenDetails?.noCacheTokens;
        if (noCache != null) {
            return noCache;
        }

        // Provider didn't break it down: derive from the total minus cache parts.
        const total = usage.inputTokens ?? 0;
        const derived = total - usageCacheReadTokens(usage) - usageCacheWriteTokens(usage);
        return Math.max(0, derived);
    }

    // ai@5 flat usage: inputTokens already excluded cache tokens.
    return usage.inputTokens ?? 0;
}

/**
 * Build a full v7 `LanguageModelUsage` from flat token counts (legacy shape
 * used by persisted sessions, tests, and ask's own message records).
 *
 * The flat `inputTokens` is the ai@5 value, which EXCLUDED cache tokens — so
 * it maps to `noCacheTokens`, and the v7 total `inputTokens` is rebuilt as
 * `input + cachedRead` to match the invariant real providers report
 * (`total = noCache + cacheRead + cacheWrite`). This keeps
 * `usageInputNoCacheTokens` correct on converted objects.
 */
export function toLanguageModelUsage(flat: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
}): LanguageModelUsage {
    const noCache = flat.inputTokens;
    const cacheRead = flat.cachedInputTokens;
    const inputTotal = noCache == null && cacheRead == null ? undefined : (noCache ?? 0) + (cacheRead ?? 0);

    return {
        inputTokens: inputTotal,
        inputTokenDetails: {
            noCacheTokens: noCache,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: flat.cacheWriteTokens,
        },
        outputTokens: flat.outputTokens,
        outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
        },
        totalTokens: flat.totalTokens,
    };
}
