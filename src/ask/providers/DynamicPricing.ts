import logger from "@app/logger";
import type { PricingInfo, OpenRouterModelsResponse, OpenRouterModelResponse, OpenRouterPricing } from "@ask/types";
import type { LanguageModelUsage } from "ai";
import { liteLLMPricingFetcher } from "@ask/providers/LiteLLMPricingFetcher";

export class DynamicPricingManager {
    private pricingCache = new Map<string, { pricing: PricingInfo; timestamp: number }>();
    private readonly CACHE_DURATION = 1000 * 60 * 60; // 1 hour

    async getPricing(provider: string, modelId: string): Promise<PricingInfo | null> {
        const cacheKey = `${provider}/${modelId}`;
        const cached = this.pricingCache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
            return cached.pricing;
        }

        const pricing = await this.fetchPricing(provider, modelId);
        if (pricing) {
            this.pricingCache.set(cacheKey, { pricing, timestamp: Date.now() });
        }

        return pricing;
    }

    private async fetchPricing(provider: string, modelId: string): Promise<PricingInfo | null> {
        try {
            // 1. For OpenRouter provider, use LiteLLM's openrouter/* pricing first
            if (provider === "openrouter") {
                const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(`openrouter/${modelId}`);
                if (liteLLMPricing) {
                    logger.debug(`Using LiteLLM pricing for openrouter/${modelId}`);
                    return liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);
                }
                // Fallback to OpenRouter API
                return await this.fetchOpenRouterPricing(modelId);
            }

            // 2. Use direct provider pricing FIRST (more accurate for direct API calls)
            switch (provider) {
                case "openai": {
                    const openAIPricing = await this.fetchOpenAIPricing(modelId);
                    if (openAIPricing) {
                        return openAIPricing;
                    }
                    // Fallback to LiteLLM for unknown OpenAI models
                    break;
                }
                case "anthropic": {
                    // Try LiteLLM first for Anthropic (for tiered pricing support)
                    const liteLLMCandidates = [
                        `${provider}/${modelId}`, // e.g., anthropic/claude-3-5-sonnet-20241022
                        modelId, // e.g., claude-3-5-sonnet-20241022
                    ];

                    for (const candidate of liteLLMCandidates) {
                        const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(candidate);
                        if (liteLLMPricing && !candidate.startsWith("openrouter/")) {
                            logger.debug(`Using LiteLLM pricing for ${candidate}`);
                            return liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);
                        }
                    }
                    // Fallback to OpenRouter
                    return await this.fetchOpenRouterPricing(`anthropic/${modelId}`);
                }
                case "google":
                    return await this.fetchGooglePricing(modelId);
                case "groq":
                    return await this.fetchGroqPricing(modelId);
                case "xai":
                    return await this.fetchXAIPricing(modelId);
                default:
                    // For unknown providers, try LiteLLM first
                    const liteLLMCandidates = [`${provider}/${modelId}`, modelId];

                    for (const candidate of liteLLMCandidates) {
                        const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(candidate);
                        if (liteLLMPricing && !candidate.startsWith("openrouter/")) {
                            logger.debug(`Using LiteLLM pricing for ${candidate}`);
                            return liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);
                        }
                    }
                    // Fallback to OpenRouter for all other providers
                    return await this.fetchOpenRouterPricing(`${provider}/${modelId}`);
            }

            // 3. For OpenAI models not in direct pricing, try LiteLLM as fallback
            if (provider === "openai") {
                const liteLLMCandidates = [`${provider}/${modelId}`, modelId];

                for (const candidate of liteLLMCandidates) {
                    const liteLLMPricing = await liteLLMPricingFetcher.getModelPricing(candidate);
                    if (liteLLMPricing && !candidate.startsWith("openrouter/")) {
                        logger.debug(`Using LiteLLM pricing for ${candidate} (fallback)`);
                        return liteLLMPricingFetcher.convertToPricingInfo(liteLLMPricing);
                    }
                }
                // Final fallback to OpenRouter
                return await this.fetchOpenRouterPricing(`openai/${modelId}`);
            }

            return null;
        } catch (error) {
            logger.warn({ error }, `Failed to fetch pricing for ${provider}/${modelId}, falling back to OpenRouter`);
            return await this.fetchOpenRouterPricing(`${provider}/${modelId}`);
        }
    }

    /**
     * Convert OpenRouter pricing per token to PricingInfo (per million tokens)
     * OpenRouter API returns pricing per token (e.g., "0.00000015" = $0.15 per million tokens)
     */
    private convertOpenRouterPricing(pricing: OpenRouterPricing): PricingInfo {
        const promptPricePerToken =
            typeof pricing.prompt === "string" ? parseFloat(pricing.prompt) : pricing.prompt ?? 0;
        const completionPricePerToken =
            typeof pricing.completion === "string" ? parseFloat(pricing.completion) : pricing.completion ?? 0;

        // Handle both cache_read and input_cache_read field names
        const cachePricePerToken =
            pricing.cache_read !== undefined
                ? typeof pricing.cache_read === "string"
                    ? parseFloat(pricing.cache_read)
                    : pricing.cache_read
                : pricing.input_cache_read !== undefined
                ? typeof pricing.input_cache_read === "string"
                    ? parseFloat(pricing.input_cache_read)
                    : pricing.input_cache_read
                : undefined;

        return {
            inputPer1M: promptPricePerToken * 1_000_000, // Convert per-token to per-million
            outputPer1M: completionPricePerToken * 1_000_000, // Convert per-token to per-million
            cachedReadPer1M: cachePricePerToken ? cachePricePerToken * 1_000_000 : undefined, // Convert per-token to per-million
        };
    }

    private async fetchOpenRouterPricing(modelId: string): Promise<PricingInfo | null> {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/models", {
                headers: {
                    "X-Title": "GenesisTools ASK",
                },
            });

            if (!response.ok) {
                throw new Error(`OpenRouter API error: ${response.status}`);
            }

            const data = (await response.json()) as OpenRouterModelsResponse;

            const model = data.data.find((m: OpenRouterModelResponse) => m.id === modelId);
            if (!model?.pricing) {
                return null;
            }

            return this.convertOpenRouterPricing(model.pricing);
        } catch (error) {
            logger.warn(`Failed to fetch OpenRouter pricing: ${error}`);
            return null;
        }
    }

    private async fetchOpenAIPricing(modelId: string): Promise<PricingInfo | null> {
        // OpenAI direct pricing (as of 2024)
        // Source: https://platform.openai.com/pricing
        const openAIPricing: Record<string, PricingInfo> = {
            "gpt-4o": {
                inputPer1M: 5.0, // $5.00 per million tokens
                outputPer1M: 15.0, // $15.00 per million tokens
                cachedReadPer1M: 2.5, // $2.50 per million tokens (estimated)
            },
            "gpt-4o-mini": {
                inputPer1M: 0.15, // $0.15 per million tokens
                outputPer1M: 0.6, // $0.60 per million tokens
                cachedReadPer1M: 0.075, // $0.075 per million cached read tokens
                cachedCreatePer1M: 0, // $0 per million cached creation tokens
            },
            "gpt-4-turbo": {
                inputPer1M: 10.0, // $10.00 per million tokens
                outputPer1M: 30.0, // $30.00 per million tokens
            },
            "gpt-4": {
                inputPer1M: 30.0, // $30.00 per million tokens
                outputPer1M: 60.0, // $60.00 per million tokens
            },
            "gpt-3.5-turbo": {
                inputPer1M: 0.5, // $0.50 per million tokens
                outputPer1M: 1.5, // $1.50 per million tokens
            },
        };

        const pricing = openAIPricing[modelId];
        if (pricing) {
            logger.debug(`Using OpenAI direct pricing for ${modelId}`);
            return pricing;
        }

        // Fallback to OpenRouter for unknown models
        logger.debug(`No direct pricing for ${modelId}, falling back to OpenRouter`);
        return await this.fetchOpenRouterPricing(`openai/${modelId}`);
    }

    private async fetchAnthropicPricing(modelId: string): Promise<PricingInfo | null> {
        // Anthropic doesn't have a public pricing API, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`anthropic/${modelId}`);
    }

    private async fetchGooglePricing(modelId: string): Promise<PricingInfo | null> {
        // Google doesn't have a public pricing API, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`google/${modelId}`);
    }

    private async fetchGroqPricing(modelId: string): Promise<PricingInfo | null> {
        // Groq pricing, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`groq/${modelId}`);
    }

    private async fetchXAIPricing(modelId: string): Promise<PricingInfo | null> {
        // xAI pricing, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`xai/${modelId}`);
    }

    // Fallback pricing estimates for common models when API calls fail
    private getFallbackPricing(provider: string, modelId: string): PricingInfo | null {
        const fallbackPricing: Record<string, Record<string, PricingInfo>> = {
            openai: {
                "gpt-4-turbo": { inputPer1M: 10.0, outputPer1M: 30.0 },
                "gpt-4": { inputPer1M: 30.0, outputPer1M: 60.0 },
                "gpt-3.5-turbo": { inputPer1M: 0.5, outputPer1M: 1.5 },
                "gpt-4o": { inputPer1M: 5.0, outputPer1M: 15.0 },
                "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, cachedReadPer1M: 0.075, cachedCreatePer1M: 0 },
            },
            anthropic: {
                "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
                "claude-3-opus-20240229": { inputPer1M: 15.0, outputPer1M: 75.0 },
                "claude-3-sonnet-20240229": { inputPer1M: 3.0, outputPer1M: 15.0 },
                "claude-3-haiku-20240307": { inputPer1M: 0.25, outputPer1M: 1.25 },
            },
            groq: {
                "llama-3.1-405b-reasoning": { inputPer1M: 9.5, outputPer1M: 9.5 },
                "llama-3.1-70b-versatile": { inputPer1M: 0.7, outputPer1M: 0.7 },
                "llama-3.1-8b-instant": { inputPer1M: 0.05, outputPer1M: 0.05 },
                "mixtral-8x7b-32768": { inputPer1M: 0.5, outputPer1M: 0.5 },
            },
        };

        return fallbackPricing[provider]?.[modelId] || null;
    }

    async calculateCost(provider: string, model: string, usage: LanguageModelUsage): Promise<number> {
        // DEBUG: Log the usage object structure
        logger.debug(`[DynamicPricing] calculateCost called for ${provider}/${model}`);
        logger.debug({ usage: JSON.stringify(usage, null, 2) }, `[DynamicPricing] usage object`);
        logger.debug({ type: typeof usage }, `[DynamicPricing] usage type`);
        logger.debug({ keys: Object.keys(usage || {}) }, `[DynamicPricing] usage keys`);
        logger.debug({ inputTokens: usage.inputTokens }, `[DynamicPricing] usage.inputTokens`);
        logger.debug({ outputTokens: usage.outputTokens }, `[DynamicPricing] usage.outputTokens`);
        logger.debug({ totalTokens: usage.totalTokens }, `[DynamicPricing] usage.totalTokens`);
        logger.debug({ cachedInputTokens: usage.cachedInputTokens }, `[DynamicPricing] usage.cachedInputTokens`);

        const pricing = await this.getPricing(provider, model);

        if (!pricing) {
            logger.warn(`Could not determine pricing for ${provider}/${model}`);
            return 0;
        }

        // Extract tokens using new API naming
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cachedReadTokens = usage.cachedInputTokens ?? 0;
        // Note: AI SDK doesn't distinguish cache creation vs read, so we use cachedReadTokens for both
        const cachedCreateTokens = 0; // Not available from AI SDK usage object

        logger.debug({ inputTokens, outputTokens, cachedReadTokens }, `[DynamicPricing] Using tokens`);

        // Check if model supports tiered pricing
        const hasTieredPricing =
            pricing.inputPer1MAbove200k != null ||
            pricing.outputPer1MAbove200k != null ||
            pricing.cachedReadPer1MAbove200k != null ||
            pricing.cachedCreatePer1MAbove200k != null;

        let inputCost: number;
        let outputCost: number;
        let cachedReadCost: number;
        let cachedCreateCost: number;

        if (hasTieredPricing && (inputTokens > 200_000 || outputTokens > 200_000)) {
            // Use tiered pricing calculation (pricing is per million tokens)
            const calculateTieredCost = (tokens: number, basePricePer1M: number, tieredPricePer1M?: number): number => {
                if (tokens <= 0) return 0;
                if (tokens > 200_000 && tieredPricePer1M != null) {
                    const tokensBelow200k = 200_000;
                    const tokensAbove200k = tokens - 200_000;
                    return (
                        (tokensBelow200k / 1_000_000) * basePricePer1M +
                        (tokensAbove200k / 1_000_000) * tieredPricePer1M
                    );
                }
                return (tokens / 1_000_000) * basePricePer1M;
            };

            inputCost = calculateTieredCost(inputTokens, pricing.inputPer1M, pricing.inputPer1MAbove200k);
            outputCost = calculateTieredCost(outputTokens, pricing.outputPer1M, pricing.outputPer1MAbove200k);
            cachedReadCost = pricing.cachedReadPer1M
                ? calculateTieredCost(cachedReadTokens, pricing.cachedReadPer1M, pricing.cachedReadPer1MAbove200k)
                : 0;
            cachedCreateCost = pricing.cachedCreatePer1M
                ? calculateTieredCost(cachedCreateTokens, pricing.cachedCreatePer1M, pricing.cachedCreatePer1MAbove200k)
                : 0;
        } else {
            // Use flat pricing (pricing is per million tokens)
            inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
            outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
            cachedReadCost = pricing.cachedReadPer1M ? (cachedReadTokens / 1_000_000) * pricing.cachedReadPer1M : 0;
            cachedCreateCost = pricing.cachedCreatePer1M
                ? (cachedCreateTokens / 1_000_000) * pricing.cachedCreatePer1M
                : 0;
        }

        const totalCost = inputCost + outputCost + cachedReadCost + cachedCreateCost;
        logger.debug(
            { inputCost, outputCost, cachedReadCost, cachedCreateCost, totalCost },
            `[DynamicPricing] Calculated costs`
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
        this.pricingCache.clear();
    }

    getCacheSize(): number {
        return this.pricingCache.size;
    }
}

// Singleton instance
export const dynamicPricingManager = new DynamicPricingManager();
