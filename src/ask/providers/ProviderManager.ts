import logger from "@app/logger";
import type { ProviderV1 } from "@ai-sdk/provider";
import type {
    DetectedProvider,
    ModelInfo,
    ProviderConfig,
    OpenRouterModelsResponse,
    OpenRouterModelResponse,
    OpenRouterPricing,
    OpenAIModelsResponse,
    PricingInfo,
} from "@ask/types";
import { getProviderConfigs, KNOWN_MODELS } from "@ask/providers/providers";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";

export class ProviderManager {
    private detectedProviders: Map<string, DetectedProvider> = new Map();
    private initialized = false;

    async detectProviders(): Promise<DetectedProvider[]> {
        if (this.initialized) {
            return Array.from(this.detectedProviders.values());
        }

        const configs = getProviderConfigs();
        const detected: DetectedProvider[] = [];

        for (const config of configs) {
            const apiKey = process.env[config.envKey];
            if (!apiKey) {
                continue; // Skip providers without API keys
            }

            try {
                const provider = await this.createProvider(config);
                if (provider) {
                    const models = await this.getAvailableModels(config, provider);
                    const detectedProvider: DetectedProvider = {
                        name: config.name,
                        type: config.type,
                        key: apiKey,
                        provider,
                        models,
                        config,
                    };

                    detected.push(detectedProvider);
                    this.detectedProviders.set(config.name, detectedProvider);

                    logger.info(`Detected ${config.name} provider with ${models.length} models`);
                }
            } catch (error) {
                logger.warn(`Failed to initialize ${config.name} provider: ${error}`);
            }
        }

        this.initialized = true;

        if (detected.length === 0) {
            logger.warn("No AI providers detected. Please set API keys in environment variables.");
            logger.info("Supported providers: " + configs.map((c) => c.envKey).join(", "));
        }

        return detected;
    }

    private async createProvider(config: ProviderConfig): Promise<ProviderV1> {
        try {
            switch (config.type) {
                case "openai": {
                    const { openai } = await import("@ai-sdk/openai");
                    return openai;
                }

                case "anthropic": {
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { anthropic } = await import("@ai-sdk/anthropic");
                    return anthropic;
                }

                case "google": {
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { google } = await import("@ai-sdk/google");
                    return google;
                }

                case "groq": {
                    // @ts-expect-error - Optional dependency, may not be installed
                    const { groq } = await import("@ai-sdk/groq");
                    return groq;
                }

                case "openai-compatible": {
                    const { createOpenAI } = await import("@ai-sdk/openai");
                    return createOpenAI({
                        apiKey: process.env[config.envKey],
                        baseURL: config.baseURL,
                    });
                }

                default:
                    throw new Error(`Unsupported provider type: ${config.type}`);
            }
        } catch (error) {
            logger.error(`Failed to create provider ${config.name}: ${error}`);
            throw error;
        }
    }

    private async getAvailableModels(config: ProviderConfig, _provider: ProviderV1): Promise<ModelInfo[]> {
        try {
            // For OpenRouter, we can query the API for available models
            if (config.name === "openrouter") {
                return await this.getOpenRouterModels();
            }

            // For OpenAI, query the API for available models
            if (config.name === "openai") {
                return await this.getOpenAIModels();
            }

            // For other providers, use known model lists
            const knownModels = KNOWN_MODELS[config.name as keyof typeof KNOWN_MODELS];
            if (knownModels) {
                // Fetch pricing for all models in parallel
                const modelsWithPricing = await Promise.all(
                    knownModels.map(async (model) => {
                        const pricing = await dynamicPricingManager.getPricing(config.name, model.id);
                        return {
                            ...model,
                            provider: config.name,
                            pricing: pricing || undefined,
                        };
                    })
                );

                // Sort models alphabetically by name
                modelsWithPricing.sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));

                return modelsWithPricing;
            }

            // Fallback: try to get basic model info
            logger.warn(`No known models for ${config.name}, using fallback`);
            return [
                {
                    id: "default",
                    name: `${config.name} Default Model`,
                    contextWindow: 4096,
                    capabilities: ["chat"],
                    provider: config.name,
                },
            ];
        } catch (error) {
            logger.error(`Failed to get models for ${config.name}: ${error}`);
            return [
                {
                    id: "default",
                    name: `${config.name} Default Model`,
                    contextWindow: 4096,
                    capabilities: ["chat"],
                    provider: config.name,
                },
            ];
        }
    }

    private async getOpenAIModels(): Promise<ModelInfo[]> {
        try {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error("OpenAI API key not found");
            }

            const response = await fetch("https://api.openai.com/v1/models", {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = (await response.json()) as OpenAIModelsResponse;

            // Get known model metadata for enrichment
            const knownModels = KNOWN_MODELS.openai || [];
            const knownModelsMap = new Map(knownModels.map((m) => [m.id, m]));

            // Filter to only chat models (exclude embeddings, fine-tuning, image, audio, etc.)
            const chatModelPrefixes = ["gpt-", "o1-", "o3-"];
            const excludedPatterns = [
                "image",
                "audio",
                "embedding",
                "whisper",
                "tts",
                "dall-e",
                "moderation",
                "instruct",
            ];
            const chatModels = data.data.filter(
                (model) =>
                    chatModelPrefixes.some((prefix) => model.id.startsWith(prefix)) &&
                    !excludedPatterns.some((pattern) => model.id.toLowerCase().includes(pattern)) &&
                    // Only include models owned by OpenAI (exclude user-created fine-tuned models)
                    (model.owned_by === "openai" || model.owned_by === "system")
            );

            const models: ModelInfo[] = await Promise.all(
                chatModels.map(async (model) => {
                    // Use known metadata if available, otherwise infer from model ID
                    const knownModel = knownModelsMap.get(model.id);
                    const capabilities = this.inferCapabilitiesFromModelId(model.id, knownModel?.capabilities);
                    const contextWindow = knownModel?.contextWindow || this.inferContextWindowFromModelId(model.id);

                    const pricing = await dynamicPricingManager.getPricing("openai", model.id);

                    return {
                        id: model.id,
                        name: knownModel?.name || this.formatModelName(model.id),
                        contextWindow,
                        capabilities,
                        provider: "openai",
                        pricing: pricing || undefined,
                    };
                })
            );

            // Sort models alphabetically by name
            models.sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));

            return models;
        } catch (error) {
            logger.error(`Failed to fetch OpenAI models: ${error}`);
            // Fallback to known models
            const knownModels = KNOWN_MODELS.openai || [];
            return await Promise.all(
                knownModels.map(async (model) => {
                    const pricing = await dynamicPricingManager.getPricing("openai", model.id);
                    return {
                        ...model,
                        provider: "openai",
                        pricing: pricing || undefined,
                    };
                })
            );
        }
    }

    private inferCapabilitiesFromModelId(modelId: string, knownCapabilities?: string[]): string[] {
        if (knownCapabilities) {
            return knownCapabilities;
        }

        const capabilities: string[] = ["chat"];

        // Infer capabilities from model ID patterns
        if (modelId.includes("vision") || modelId.includes("o1") || modelId.includes("o3")) {
            capabilities.push("vision");
        }

        if (modelId.includes("function") || modelId.startsWith("gpt-4") || modelId.startsWith("gpt-3.5-turbo")) {
            capabilities.push("function-calling");
        }

        if (modelId.includes("reasoning") || modelId.startsWith("o1") || modelId.startsWith("o3")) {
            capabilities.push("reasoning");
        }

        return capabilities;
    }

    private inferContextWindowFromModelId(modelId: string): number {
        // Default context windows based on model family
        if (modelId.startsWith("gpt-4o") || modelId.startsWith("o1") || modelId.startsWith("o3")) {
            return 128000;
        }
        if (modelId.startsWith("gpt-4-turbo")) {
            return 128000;
        }
        if (modelId.startsWith("gpt-4")) {
            return 8192;
        }
        if (modelId.startsWith("gpt-3.5-turbo")) {
            return 16384;
        }
        // Default fallback
        return 4096;
    }

    private formatModelName(modelId: string): string {
        // Convert model ID to readable name
        // e.g., "gpt-4-turbo-preview" -> "GPT-4 Turbo Preview"
        return modelId
            .split("-")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(" ");
    }

    private async getOpenRouterModels(): Promise<ModelInfo[]> {
        try {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
                throw new Error("OpenRouter API key not found");
            }

            const response = await fetch("https://openrouter.ai/api/v1/models", {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
            });

            if (!response.ok) {
                throw new Error(`OpenRouter API error: ${response.status}`);
            }

            const data = (await response.json()) as OpenRouterModelsResponse;

            const models: ModelInfo[] = data.data.map((model: OpenRouterModelResponse) => {
                return {
                    id: model.id,
                    name: model.name || model.id,
                    contextWindow: model.context_length || 4096,
                    pricing: model.pricing ? this.convertOpenRouterPricing(model.pricing) : undefined,
                    capabilities: this.parseCapabilities({
                        id: model.id,
                        description: model.description,
                    }),
                    provider: "openrouter",
                };
            });

            // Sort models alphabetically by name
            models.sort((a: ModelInfo, b: ModelInfo) => a.name.localeCompare(b.name));

            return models;
        } catch (error) {
            logger.error(`Failed to fetch OpenRouter models: ${error}`);
            return [];
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

    private parseCapabilities(model: { id: string; description?: string }): string[] {
        const capabilities: string[] = ["chat"];

        if (model.description?.toLowerCase().includes("vision") || model.id.toLowerCase().includes("vision")) {
            capabilities.push("vision");
        }

        if (model.description?.toLowerCase().includes("function") || model.id.toLowerCase().includes("tool")) {
            capabilities.push("function-calling");
        }

        if (model.description?.toLowerCase().includes("reasoning") || model.id.toLowerCase().includes("reasoning")) {
            capabilities.push("reasoning");
        }

        return capabilities;
    }

    async validateProvider(providerName: string): Promise<boolean> {
        try {
            const providers = await this.detectProviders();
            const provider = providers.find((p) => p.name === providerName);

            if (!provider) {
                return false;
            }

            // Try a minimal request to validate the provider
            const { generateText } = await import("ai");
            const modelId = provider.models[0]?.id || "default";
            const model = provider.provider(modelId);
            await generateText({
                model,
                prompt: "test",
                maxTokens: 1,
            });

            return true;
        } catch (error) {
            logger.warn(`Provider validation failed for ${providerName}: ${error}`);
            return false;
        }
    }

    getProvider(name: string): DetectedProvider | undefined {
        return this.detectedProviders.get(name);
    }

    getAvailableProviders(): DetectedProvider[] {
        return Array.from(this.detectedProviders.values());
    }

    async getModelsForProvider(providerName: string): Promise<ModelInfo[]> {
        const provider = this.getProvider(providerName);
        return provider?.models || [];
    }
}

// Singleton instance
export const providerManager = new ProviderManager();
