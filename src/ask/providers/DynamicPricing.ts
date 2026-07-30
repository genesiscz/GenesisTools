import type { PricingInfo } from "@ask/types";
import { usageCacheReadTokens, usageCacheWriteTokens, usageInputNoCacheTokens } from "@ask/utils/helpers";
import { clearPricingCache, pricingCacheSize, pricingFor } from "@genesiscz/utils/ai/catalog/pricing";
import { logger } from "@genesiscz/utils/logger";
import type { LanguageModelUsage } from "ai";

/**
 * Compatibility shim over `@genesiscz/utils/ai/catalog/pricing`.
 *
 * The price ladder and its caching now live in the catalog, where every AI
 * surface can reach them rather than importing ask's internals. This class
 * keeps the old method surface for its six existing consumers (CostTracker,
 * CostPredictor, ChatEngine, ConversationManager, src/usage, the claude
 * summarize engine) until Phase 8 flips them.
 *
 * The cost math below stays here because it reads ai-sdk usage objects, which
 * is the caller's shape, not the catalog's.
 *
 * @deprecated Use `pricingFor` from `@genesiscz/utils/ai/catalog/pricing`.
 */
export class DynamicPricingManager {
    async getPricing(provider: string, modelId: string): Promise<PricingInfo | null> {
        return (await pricingFor(provider, modelId)) ?? null;
    }

    async calculateCost(provider: string, model: string, usage: LanguageModelUsage): Promise<number> {
        const pricing = await this.getPricing(provider, model);

        if (!pricing) {
            logger.warn(`Could not determine pricing for ${provider}/${model}`);
            return 0;
        }

        // Base input is the NON-cached portion only — ai@7's `inputTokens`
        // includes cache read/write on some providers (e.g. anthropic@4), so
        // pricing it here would double-charge against the cache costs below.
        const inputTokens = usageInputNoCacheTokens(usage);
        const outputTokens = usage.outputTokens ?? 0;
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

        const totalCost = inputCost + outputCost + cachedReadCost + cachedCreateCost;
        logger.debug(
            { provider, model, inputCost, outputCost, cachedReadCost, cachedCreateCost, totalCost },
            "calculated call cost"
        );

        return totalCost;
    }

    formatCost(cost: number): string {
        // Show more precision for very small costs
        if (cost > 0 && cost < 0.0001) {
            return `$${cost.toExponential(2)}`;
        }

        return `$${cost.toFixed(4)}`;
    }

    formatTokens(tokens: number): string {
        return `${(tokens / 1000).toFixed(1)}k`;
    }

    clearCache(): void {
        clearPricingCache();
    }

    getCacheSize(): number {
        return pricingCacheSize();
    }
}

export const dynamicPricingManager = new DynamicPricingManager();
