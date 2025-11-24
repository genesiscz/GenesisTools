import logger from "../../logger";
import type { PricingInfo } from "../types";
import type { LanguageModelUsage } from "ai";

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
            switch (provider) {
                case "openai":
                    // Use OpenAI direct pricing first
                    const openAIPricing = await this.fetchOpenAIPricing(modelId);
                    if (openAIPricing) {
                        return openAIPricing;
                    }
                    // Fallback to OpenRouter if not found
                    return await this.fetchOpenRouterPricing(`openai/${modelId}`);
                case "anthropic":
                    return await this.fetchAnthropicPricing(modelId);
                case "google":
                    return await this.fetchGooglePricing(modelId);
                case "groq":
                    return await this.fetchGroqPricing(modelId);
                case "xai":
                    return await this.fetchXAIPricing(modelId);
                default:
                    // Fallback to OpenRouter for all other providers
                    return await this.fetchOpenRouterPricing(`${provider}/${modelId}`);
            }
        } catch (error) {
            logger.warn(`Failed to fetch pricing for ${provider}/${modelId}, falling back to OpenRouter:`, error);
            return await this.fetchOpenRouterPricing(`${provider}/${modelId}`);
        }
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

            interface OpenRouterModel {
                id: string;
                pricing?: {
                    prompt: number;
                    completion: number;
                    cache_read?: number;
                };
            }

            const data = (await response.json()) as { data: OpenRouterModel[] };

            const model = data.data.find((m) => m.id === modelId);
            if (!model?.pricing) {
                return null;
            }

            // OpenRouter pricing is per million tokens, convert to per thousand
            // Example: $0.0000025 per million = $0.0000025 / 1000 = $0.0000000025 per thousand
            const promptPrice =
                typeof model.pricing.prompt === "string" ? parseFloat(model.pricing.prompt) : model.pricing.prompt;
            const completionPrice =
                typeof model.pricing.completion === "string"
                    ? parseFloat(model.pricing.completion)
                    : model.pricing.completion;
            const cachePrice = model.pricing.cache_read
                ? typeof model.pricing.cache_read === "string"
                    ? parseFloat(model.pricing.cache_read)
                    : model.pricing.cache_read
                : undefined;

            return {
                input: promptPrice / 1000, // Convert from per-million to per-thousand
                output: completionPrice / 1000,
                cachedInput: cachePrice ? cachePrice / 1000 : undefined,
            };
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
                input: 5.0 / 1000, // $5.00 per million = $0.005 per thousand
                output: 15.0 / 1000, // $15.00 per million = $0.015 per thousand
                cachedInput: 2.5 / 1000, // $2.50 per million = $0.0025 per thousand (estimated)
            },
            "gpt-4o-mini": {
                input: 0.15 / 1000, // $0.15 per million = $0.00015 per thousand
                output: 0.6 / 1000, // $0.60 per million = $0.0006 per thousand
            },
            "gpt-4-turbo": {
                input: 10.0 / 1000, // $10.00 per million = $0.01 per thousand
                output: 30.0 / 1000, // $30.00 per million = $0.03 per thousand
            },
            "gpt-4": {
                input: 30.0 / 1000, // $30.00 per million = $0.03 per thousand
                output: 60.0 / 1000, // $60.00 per million = $0.06 per thousand
            },
            "gpt-3.5-turbo": {
                input: 0.5 / 1000, // $0.50 per million = $0.0005 per thousand
                output: 1.5 / 1000, // $1.50 per million = $0.0015 per thousand
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
                "gpt-4-turbo": { input: 0.01, output: 0.03 },
                "gpt-4": { input: 0.03, output: 0.06 },
                "gpt-3.5-turbo": { input: 0.0015, output: 0.002 },
                "gpt-4o": { input: 0.005, output: 0.015 },
                "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
            },
            anthropic: {
                "claude-3-5-sonnet-20241022": { input: 0.003, output: 0.015 },
                "claude-3-opus-20240229": { input: 0.015, output: 0.075 },
                "claude-3-sonnet-20240229": { input: 0.003, output: 0.015 },
                "claude-3-haiku-20240307": { input: 0.00025, output: 0.00125 },
            },
            groq: {
                "llama-3.1-405b-reasoning": { input: 0.0095, output: 0.0095 },
                "llama-3.1-70b-versatile": { input: 0.0007, output: 0.0007 },
                "llama-3.1-8b-instant": { input: 0.00005, output: 0.00005 },
                "mixtral-8x7b-32768": { input: 0.0005, output: 0.0005 },
            },
        };

        return fallbackPricing[provider]?.[modelId] || null;
    }

    async calculateCost(provider: string, model: string, usage: LanguageModelUsage): Promise<number> {
        // DEBUG: Log the usage object structure
        logger.debug(`[DynamicPricing] calculateCost called for ${provider}/${model}`);
        logger.debug(`[DynamicPricing] usage object:`, JSON.stringify(usage, null, 2));
        logger.debug(`[DynamicPricing] usage type:`, typeof usage);
        logger.debug(`[DynamicPricing] usage keys:`, Object.keys(usage || {}));
        logger.debug(`[DynamicPricing] usage.promptTokens:`, usage.promptTokens);
        logger.debug(`[DynamicPricing] usage.completionTokens:`, usage.completionTokens);
        logger.debug(`[DynamicPricing] usage.totalTokens:`, usage.totalTokens);
        logger.debug(`[DynamicPricing] usage.inputTokens:`, (usage as any).inputTokens);
        logger.debug(`[DynamicPricing] usage.outputTokens:`, (usage as any).outputTokens);
        logger.debug(`[DynamicPricing] usage.cachedPromptTokens:`, usage.cachedPromptTokens);

        const pricing = await this.getPricing(provider, model);

        if (!pricing) {
            logger.warn(`Could not determine pricing for ${provider}/${model}`);
            return 0;
        }

        // Try both naming conventions (promptTokens/completionTokens vs inputTokens/outputTokens)
        const inputTokens = usage.promptTokens ?? (usage as any).inputTokens ?? 0;
        const outputTokens = usage.completionTokens ?? (usage as any).outputTokens ?? 0;
        const cachedInputTokens = usage.cachedPromptTokens ?? (usage as any).cachedInputTokens ?? 0;

        logger.debug(
            `[DynamicPricing] Using tokens - input: ${inputTokens}, output: ${outputTokens}, cached: ${cachedInputTokens}`
        );

        // Pricing is per thousand tokens, so: (tokens / 1000) * price_per_thousand
        const inputCost = (inputTokens / 1000) * pricing.input;
        const outputCost = (outputTokens / 1000) * pricing.output;
        const cachedInputCost = pricing.cachedInput ? (cachedInputTokens / 1000) * pricing.cachedInput : 0;

        const totalCost = inputCost + outputCost + cachedInputCost;
        logger.debug(
            `[DynamicPricing] Calculated costs - input: ${inputCost}, output: ${outputCost}, cached: ${cachedInputCost}, total: ${totalCost}`
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
