import type { PricingInfo } from "@ask/types";
import { clearPricingCache, pricingCacheSize, pricingForCall } from "@genesiscz/utils/ai/catalog/pricing";
import { calculateCallCostUsd } from "@genesiscz/utils/ai/llm-cost";
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
 * @deprecated Use `pricingFor` from `@genesiscz/utils/ai/catalog/pricing` and
 * `calculateCallCostUsd` from `@genesiscz/utils/ai/llm-cost`.
 */
export class DynamicPricingManager {
    async getPricing(provider: string, modelId: string): Promise<PricingInfo | null> {
        // Resolved, not raw. `pricingFor` answers with the catalog's rules still
        // unapplied, so this shim used to bill a model at its list rate while the
        // usage ledger recorded the dated rate for the same call.
        return (await pricingForCall(provider, modelId, { at: new Date() })) ?? null;
    }

    async calculateCost(provider: string, model: string, usage: LanguageModelUsage): Promise<number> {
        const pricing = await this.getPricing(provider, model);

        if (!pricing) {
            logger.warn(`Could not determine pricing for ${provider}/${model}`);
            return 0;
        }

        const totalCost = calculateCallCostUsd(pricing, usage) ?? 0;
        logger.debug({ provider, model, totalCost }, "calculated call cost");

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
