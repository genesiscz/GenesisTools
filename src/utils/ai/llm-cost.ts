import {
    type LegacyFlatUsage,
    usageCacheReadTokens,
    usageCacheWriteTokens,
    usageInputNoCacheTokens,
} from "@genesiscz/utils/ask/usage-tokens";
import type { LanguageModelUsage } from "ai";

/**
 * Pure cost math for LLM calls. Pricing DATA does not live here — canonical
 * per-model rates come from `@genesiscz/utils/ai/catalog` (`pricingFor`, which
 * walks static → LiteLLM → OpenRouter). The ai-proxy client ledger keeps its own
 * deliberate static table in `src/ai-proxy/lib/billing/pricing.ts`
 * (deterministic invoicing).
 */
export interface TokenPricing {
    inputPer1M: number;
    outputPer1M: number;
}

/** Cache and long-context rates, all optional; `undefined` means "bill the base rate". */
export interface CallPricing extends TokenPricing {
    cachedReadPer1M?: number;
    cachedCreatePer1M?: number;
    inputPer1MAbove200k?: number;
    outputPer1MAbove200k?: number;
    cachedReadPer1MAbove200k?: number;
    cachedCreatePer1MAbove200k?: number;
}

export interface LlmCallCostOpts {
    pricing: TokenPricing | undefined;
    inputTokens: number;
    outputTokens: number;
}

/** USD for one LLM call. null = no pricing known for the model. */
export function estimateLlmCallCostUsd({ pricing, inputTokens, outputTokens }: LlmCallCostOpts): number | null {
    if (!pricing) {
        return null;
    }

    return (inputTokens / 1_000_000) * pricing.inputPer1M + (outputTokens / 1_000_000) * pricing.outputPer1M;
}

/**
 * USD for one call, from a real ai-sdk usage object.
 *
 * Unlike `estimateLlmCallCostUsd` (two token counts, flat rates) this prices the
 * four token classes a provider actually reports. The base input deliberately
 * uses `usageInputNoCacheTokens`: ai@7's anthropic provider folds cache tokens
 * into the top-level `inputTokens`, so billing on that field would charge cache
 * tokens twice, once at the full rate and once at the cache rate.
 *
 * Long-context tiers apply only when input or output crosses 200k, matching how
 * Anthropic and Google publish them.
 */
export function calculateCallCostUsd(
    pricing: CallPricing | undefined,
    usage: LanguageModelUsage | LegacyFlatUsage | undefined
): number | null {
    if (!pricing) {
        return null;
    }

    const inputTokens = usageInputNoCacheTokens(usage);
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedReadTokens = usageCacheReadTokens(usage);
    const cachedCreateTokens = usageCacheWriteTokens(usage);

    const hasTieredPricing =
        pricing.inputPer1MAbove200k != null ||
        pricing.outputPer1MAbove200k != null ||
        pricing.cachedReadPer1MAbove200k != null ||
        pricing.cachedCreatePer1MAbove200k != null;

    const flat = (tokens: number, per1M: number): number => (tokens / 1_000_000) * per1M;

    const tiered = (tokens: number, basePer1M: number, abovePer1M?: number): number => {
        if (tokens <= 0) {
            return 0;
        }

        if (tokens > 200_000 && abovePer1M != null) {
            return flat(200_000, basePer1M) + flat(tokens - 200_000, abovePer1M);
        }

        return flat(tokens, basePer1M);
    };

    const useTiers = hasTieredPricing && (inputTokens > 200_000 || outputTokens > 200_000);

    const inputCost = useTiers
        ? tiered(inputTokens, pricing.inputPer1M, pricing.inputPer1MAbove200k)
        : flat(inputTokens, pricing.inputPer1M);
    const outputCost = useTiers
        ? tiered(outputTokens, pricing.outputPer1M, pricing.outputPer1MAbove200k)
        : flat(outputTokens, pricing.outputPer1M);
    const cachedReadCost = pricing.cachedReadPer1M
        ? useTiers
            ? tiered(cachedReadTokens, pricing.cachedReadPer1M, pricing.cachedReadPer1MAbove200k)
            : flat(cachedReadTokens, pricing.cachedReadPer1M)
        : 0;
    const cachedCreateCost = pricing.cachedCreatePer1M
        ? useTiers
            ? tiered(cachedCreateTokens, pricing.cachedCreatePer1M, pricing.cachedCreatePer1MAbove200k)
            : flat(cachedCreateTokens, pricing.cachedCreatePer1M)
        : 0;

    return inputCost + outputCost + cachedReadCost + cachedCreateCost;
}

/** ~150 spoken words/min ≈ 200 tokens/min — token estimate for speech of a given length. */
const SPEECH_TOKENS_PER_SEC = 3.3;

export function estimateSpeechTokens(durationSec: number): number {
    return Math.round(durationSec * SPEECH_TOKENS_PER_SEC);
}
