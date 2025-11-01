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
                    return await this.fetchOpenAIPricing(modelId);
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

            return {
                input: model.pricing.prompt / 1000000, // Convert from per-million to per-thousand
                output: model.pricing.completion / 1000000,
                cachedInput: model.pricing.cache_read ? model.pricing.cache_read / 1000000 : undefined,
            };
        } catch (error) {
            logger.warn(`Failed to fetch OpenRouter pricing: ${error}`);
            return null;
        }
    }

    private async fetchOpenAIPricing(modelId: string): Promise<PricingInfo | null> {
        // OpenAI doesn't have a public pricing API, fallback to OpenRouter
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
        const pricing = await this.getPricing(provider, model);

        if (!pricing) {
            logger.warn(`Could not determine pricing for ${provider}/${model}`);
            return 0;
        }

        const inputTokens = usage.promptTokens || 0;
        const outputTokens = usage.completionTokens || 0;
        const cachedInputTokens = usage.cachedPromptTokens || 0;

        const inputCost = (inputTokens * pricing.input) / 1000;
        const outputCost = (outputTokens * pricing.output) / 1000;
        const cachedInputCost = pricing.cachedInput ? (cachedInputTokens * pricing.cachedInput) / 1000 : 0;

        return inputCost + outputCost + cachedInputCost;
    }

    formatCost(cost: number): string {
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
