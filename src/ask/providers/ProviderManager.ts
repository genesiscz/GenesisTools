import logger from "../../logger";
import { ProviderV1 } from "@ai-sdk/provider";
import type { DetectedProvider, ModelInfo, ProviderConfig } from "../types";
import { getProviderConfigs, KNOWN_MODELS } from "./providers";

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
      logger.info("Supported providers: " + configs.map(c => c.envKey).join(", "));
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

  private async getAvailableModels(config: ProviderConfig, provider: ProviderV1): Promise<ModelInfo[]> {
    try {
      // For OpenRouter, we can query the API for available models
      if (config.name === "openrouter") {
        return await this.getOpenRouterModels();
      }

      // For other providers, use known model lists
      const knownModels = KNOWN_MODELS[config.name as keyof typeof KNOWN_MODELS];
      if (knownModels) {
        return knownModels.map(model => ({
          ...model,
          provider: config.name,
          pricing: undefined, // Will be loaded dynamically
        }));
      }

      // Fallback: try to get basic model info
      logger.warn(`No known models for ${config.name}, using fallback`);
      return [{
        id: "default",
        name: `${config.name} Default Model`,
        contextWindow: 4096,
        capabilities: ["chat"],
        provider: config.name,
      }];
    } catch (error) {
      logger.error(`Failed to get models for ${config.name}: ${error}`);
      return [{
        id: "default",
        name: `${config.name} Default Model`,
        contextWindow: 4096,
        capabilities: ["chat"],
        provider: config.name,
      }];
    }
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

      const data = await response.json();

      return data.data.map((model: {
        id: string;
        name?: string;
        context_length?: number;
        pricing?: {
          prompt: number;
          completion: number;
          cache_read?: number;
        };
        description?: string;
      }) => ({
        id: model.id,
        name: model.name || model.id,
        contextWindow: model.context_length || 4096,
        pricing: model.pricing ? {
          input: model.pricing.prompt / 1000000, // Convert from per-million to per-thousand
          output: model.pricing.completion / 1000000,
          cachedInput: model.pricing.cache_read ? model.pricing.cache_read / 1000000 : undefined,
        } : undefined,
        capabilities: this.parseCapabilities({
          id: model.id,
          description: model.description,
        }),
        provider: "openrouter",
      }));
    } catch (error) {
      logger.error(`Failed to fetch OpenRouter models: ${error}`);
      return [];
    }
  }

  private parseCapabilities(model: { id: string; description?: string }): string[] {
    const capabilities: string[] = ["chat"];

    if (model.description?.toLowerCase().includes("vision") ||
        model.id.toLowerCase().includes("vision")) {
      capabilities.push("vision");
    }

    if (model.description?.toLowerCase().includes("function") ||
        model.id.toLowerCase().includes("tool")) {
      capabilities.push("function-calling");
    }

    if (model.description?.toLowerCase().includes("reasoning") ||
        model.id.toLowerCase().includes("reasoning")) {
      capabilities.push("reasoning");
    }

    return capabilities;
  }

  async validateProvider(providerName: string): Promise<boolean> {
    try {
      const providers = await this.detectProviders();
      const provider = providers.find(p => p.name === providerName);

      if (!provider) {
        return false;
      }

      // Try a minimal request to validate the provider
      const { generateText } = await import("ai");
      await generateText({
        model: provider.provider(provider.models[0]?.id || "default"),
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