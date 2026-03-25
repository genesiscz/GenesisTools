import type { ProviderV2 } from "@ai-sdk/provider";
import logger from "@app/logger";
import {
    createSubscriptionFetch,
    SUBSCRIPTION_BETAS,
    SUBSCRIPTION_SYSTEM_PREFIX,
} from "@app/utils/claude/subscription-billing";
import { askUI } from "@ask/output/AskUILogger";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import { liteLLMPricingFetcher } from "@ask/providers/LiteLLMPricingFetcher";
import { getProviderConfigs, KNOWN_MODELS } from "@ask/providers/providers";
import type {
    DetectedProvider,
    ModelInfo,
    OpenAIModelsResponse,
    OpenRouterModelResponse,
    OpenRouterModelsResponse,
    OpenRouterPricing,
    PricingInfo,
    ProviderConfig,
} from "@ask/types";
import { getLanguageModel } from "@ask/types";
import type { AskConfig } from "@ask/types/config";
import { generateText } from "ai";

interface ModelMetadata {
    id: string;
    description?: string;
}

export class ProviderManager {
    private detectedProviders: Map<string, DetectedProvider> = new Map();
    private initialized = false;

    async detectProviders(): Promise<DetectedProvider[]> {
        if (this.initialized) {
            return Array.from(this.detectedProviders.values());
        }

        // Load ask config for env token control and subscription settings
        const { loadAskConfig } = await import("@ask/config");
        const askConfig = await loadAskConfig();

        const configs = getProviderConfigs();
        const detected: DetectedProvider[] = [];

        for (const config of configs) {
            if (
                askConfig.envTokens?.enabled === false ||
                askConfig.envTokens?.disabledProviders?.includes(config.name)
            ) {
                continue;
            }

            // Skip anthropic env key if subscription account is configured (subscription takes priority)
            if (config.name === "anthropic" && (askConfig.claude?.accountRef || askConfig.claude?.independentToken)) {
                continue;
            }

            const apiKey = process.env[config.envKey];
            if (!apiKey) {
                continue;
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

                    askUI().logDetected({ provider: config.name, count: models.length });
                }
            } catch (error) {
                logger.warn(`Failed to initialize ${config.name} provider: ${error}`);
            }
        }

        // Check for anthropic subscription token if not already detected via env key
        if (!this.detectedProviders.has("anthropic")) {
            await this.detectAnthropicSubscription(askConfig, detected);
        }

        this.initialized = true;

        if (detected.length === 0) {
            logger.warn("No AI providers detected. Please set API keys in environment variables.");
            logger.info(`Supported providers: ${configs.map((c) => c.envKey).join(", ")}`);
        }

        return detected;
    }

    private async detectAnthropicSubscription(askConfig: AskConfig, detected: DetectedProvider[]): Promise<void> {
        if (!askConfig.claude?.accountRef && !askConfig.claude?.independentToken) {
            return;
        }

        try {
            let token: string;

            if (askConfig.claude.accountRef) {
                const { resolveAccountToken } = await import("@app/utils/claude/subscription-auth");
                const result = await resolveAccountToken(askConfig.claude.accountRef);
                token = result.token;
            } else {
                token = askConfig.claude.independentToken!;
            }

            const { createAnthropic } = await import("@ai-sdk/anthropic");
            const provider = createAnthropic({
                apiKey: "oauth-placeholder",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "anthropic-beta": SUBSCRIPTION_BETAS,
                },
                fetch: createSubscriptionFetch(),
            });

            const allConfigs = getProviderConfigs();
            const anthropicConfig = allConfigs.find((c) => c.name === "anthropic");
            if (!anthropicConfig) {
                throw new Error("anthropic provider config missing from PROVIDER_CONFIGS");
            }

            const models = await this.getAvailableModels(anthropicConfig, provider);
            const accountLabel = askConfig.claude.accountLabel;
            const hint = accountLabel ? ` (${accountLabel})` : "";

            const detectedProvider: DetectedProvider = {
                name: "anthropic",
                type: "anthropic",
                key: `${token.slice(0, 20)}...`,
                provider,
                models,
                config: anthropicConfig,
                systemPromptPrefix: SUBSCRIPTION_SYSTEM_PREFIX,
            };

            detected.push(detectedProvider);
            this.detectedProviders.set("anthropic", detectedProvider);

            askUI().logDetectedSubscription({ provider: "anthropic", hint });
        } catch (error) {
            logger.warn(`Failed to initialize anthropic subscription provider: ${error}`);

            // Fallback: try env-key if subscription detection failed
            const envKey = process.env.ANTHROPIC_API_KEY;
            if (envKey) {
                logger.info("Falling back to ANTHROPIC_API_KEY environment variable");
                try {
                    const allConfigs = getProviderConfigs();
                    const cfg = allConfigs.find((c) => c.name === "anthropic");
                    if (cfg) {
                        const provider = await this.createProvider(cfg);
                        if (provider) {
                            const models = await this.getAvailableModels(cfg, provider);
                            const detectedProvider: DetectedProvider = {
                                name: "anthropic",
                                type: "anthropic",
                                key: envKey,
                                provider,
                                models,
                                config: cfg,
                            };
                            detected.push(detectedProvider);
                            this.detectedProviders.set("anthropic", detectedProvider);
                            askUI().logDetected({ provider: "anthropic", count: models.length });
                        }
                    }
                } catch (fallbackErr) {
                    logger.warn(`Anthropic env-key fallback also failed: ${fallbackErr}`);
                }
            }
        }
    }

    private async createProvider(config: ProviderConfig): Promise<ProviderV2> {
        try {
            switch (config.type) {
                case "openai": {
                    const { openai } = await import("@ai-sdk/openai");
                    return openai;
                }

                case "anthropic": {
                    const { anthropic } = await import("@ai-sdk/anthropic");
                    return anthropic;
                }

                case "google": {
                    const { google } = await import("@ai-sdk/google");
                    return google;
                }

                case "groq": {
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

    private async getAvailableModels(config: ProviderConfig, _provider: ProviderV2): Promise<ModelInfo[]> {
        try {
            // For OpenRouter, we can query the API for available models
            if (config.name === "openrouter") {
                return await this.getOpenRouterModels();
            }

            // For OpenAI, query the API for available models
            if (config.name === "openai") {
                return await this.getOpenAIModels();
            }

            // For other providers, discover models from LiteLLM pricing data + KNOWN_MODELS fallback
            const models = await this.getModelsFromLiteLLM(config.name);
            if (models.length > 0) {
                return models;
            }

            // Fallback to KNOWN_MODELS if LiteLLM has no data for this provider
            const knownModels = KNOWN_MODELS[config.name as keyof typeof KNOWN_MODELS];
            if (knownModels) {
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

    /**
     * Discover models from LiteLLM pricing data for a given provider.
     * Returns models whose bare ID matches the provider prefix (e.g., "claude-" for anthropic).
     * Excludes versioned duplicates (dated IDs) when an alias exists.
     */
    private async getModelsFromLiteLLM(providerName: string): Promise<ModelInfo[]> {
        const prefixMap: Record<string, string> = {
            anthropic: "claude-",
            groq: "groq/",
            xai: "xai/",
        };

        const prefix = prefixMap[providerName];
        if (!prefix) {
            return [];
        }

        try {
            const allPricing = await liteLLMPricingFetcher.fetchModelPricing();
            const models: ModelInfo[] = [];
            const seenAliases = new Set<string>();

            // First pass: collect alias IDs (no date suffix) to skip dated duplicates
            for (const key of allPricing.keys()) {
                if (!key.startsWith(prefix)) {
                    continue;
                }

                // Skip keys with slashes (provider-prefixed like "anthropic/claude-...")
                if (key.includes("/") && !prefix.includes("/")) {
                    continue;
                }

                // Skip versioned keys like "claude-opus-4-6-20260205" when "claude-opus-4-6" exists
                if (!/\d{8}/.test(key)) {
                    seenAliases.add(key);
                }
            }

            for (const [key, pricingData] of allPricing) {
                if (!key.startsWith(prefix)) {
                    continue;
                }

                if (key.includes("/") && !prefix.includes("/")) {
                    continue;
                }

                // Skip dated versions when alias exists (e.g., skip "claude-opus-4-6-20260205" if "claude-opus-4-6" exists)
                const dateMatch = key.match(/^(.+)-(\d{8})(-v\d+:\d+)?$/);
                if (dateMatch && seenAliases.has(dateMatch[1])) {
                    continue;
                }

                // Skip v1:0 suffixed keys
                if (key.endsWith("-v1:0")) {
                    continue;
                }

                const pricing = liteLLMPricingFetcher.convertToPricingInfo(pricingData);
                const contextWindow = pricingData.max_input_tokens ?? pricingData.max_tokens ?? 200000;

                // Use KNOWN_MODELS for display name if available
                const knownModels = KNOWN_MODELS[providerName as keyof typeof KNOWN_MODELS];
                const known = knownModels?.find((m) => m.id === key);

                models.push({
                    id: key,
                    name: known?.name ?? this.formatModelName(key.replace(/^[^/]+\//, "")),
                    contextWindow,
                    capabilities: known?.capabilities ?? ["chat"],
                    provider: providerName,
                    pricing,
                });
            }

            models.sort((a, b) => {
                const aPrice = a.pricing?.inputPer1M ?? Infinity;
                const bPrice = b.pricing?.inputPer1M ?? Infinity;
                return aPrice - bPrice;
            });
            return models;
        } catch (error) {
            logger.warn(`Failed to get models from LiteLLM for ${providerName}: ${error}`);
            return [];
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

            // Known chat model prefixes (from @ai-sdk/openai OpenAIChatModelId type)
            const chatModelPrefixes = [
                "gpt-3.5-turbo",
                "gpt-4-turbo",
                "gpt-5-mini",
                "gpt-5-nano",
                "chatgpt-",
                "gpt-4.1",
                "gpt-4.5",
                "gpt-4o",
                "gpt-4",
                "gpt-5",
                "o1",
                "o3",
            ];

            // Models that match gpt- prefix but are NOT chat models
            const nonChatPatterns = [
                "codex", // gpt-5-codex, gpt-5.2-codex — code execution, Responses API only
                "-pro", // gpt-5-pro — specialized, Responses API only
                "instruct", // gpt-3.5-turbo-instruct — legacy completion API
                "image", // gpt-image-1 — image generation model
                "transcribe", // gpt-4o-transcribe — audio transcription
                "tts", // gpt-4o-mini-tts — text-to-speech
                "embedding", // text-embedding models
                "whisper", // whisper models
                "dall-e", // image generation
                "moderation", // content moderation
            ];

            const chatModels = data.data.filter((model) => {
                const id = model.id.toLowerCase();

                // Must NOT match any non-chat pattern
                if (nonChatPatterns.some((p) => id.includes(p))) {
                    return false;
                }

                // Must match a known chat prefix
                if (!chatModelPrefixes.some((prefix) => id.startsWith(prefix))) {
                    return false;
                }

                // Must be owned by OpenAI
                return model.owned_by === "openai" || model.owned_by === "system";
            });

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
            typeof pricing.prompt === "string" ? parseFloat(pricing.prompt) : (pricing.prompt ?? 0);
        const completionPricePerToken =
            typeof pricing.completion === "string" ? parseFloat(pricing.completion) : (pricing.completion ?? 0);

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

    private parseCapabilities(model: ModelMetadata): string[] {
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
            const modelId = provider.models[0]?.id || "default";
            const model = getLanguageModel(provider.provider, modelId);
            await generateText({
                model,
                prompt: "test",
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
