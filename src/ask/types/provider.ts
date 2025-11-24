import type { ProviderV1 } from "@ai-sdk/provider";
import type { ModelInfo } from "./chat";

export interface ProviderConfig {
    name: string;
    type: string;
    envKey: string;
    import?: string;
    baseURL?: string;
    description?: string;
    priority: number;
}

export interface DetectedProvider {
    name: string;
    type: string;
    key: string;
    provider: ProviderV1;
    models: ModelInfo[];
    config: ProviderConfig;
}

export interface PricingInfo {
    inputPer1M: number; // Cost per 1M input tokens
    outputPer1M: number; // Cost per 1M output tokens
    cachedReadPer1M?: number; // Cost per 1M cached read tokens
    cachedCreatePer1M?: number; // Cost per 1M cached creation tokens
    // Tiered pricing (for models with >200k context windows)
    inputPer1MAbove200k?: number; // Cost per 1M input tokens above 200k threshold
    outputPer1MAbove200k?: number; // Cost per 1M output tokens above 200k threshold
    cachedReadPer1MAbove200k?: number; // Cost per 1M cached read tokens above 200k threshold
    cachedCreatePer1MAbove200k?: number; // Cost per 1M cached creation tokens above 200k threshold
}

/**
 * OpenRouter API pricing information
 * Prices are returned per token (e.g., "0.00000015" = $0.15 per million tokens)
 */
export interface OpenRouterPricing {
    prompt: number | string; // Input/prompt price per token
    completion: number | string; // Output/completion price per token
    cache_read?: number | string; // Cached read price per token (models endpoint)
    input_cache_read?: number | string; // Cached read price per token (pricing endpoint)
}

/**
 * OpenRouter API model response
 * Represents a model returned from OpenRouter's /api/v1/models endpoint
 */
export interface OpenRouterModelResponse {
    id: string;
    name?: string;
    context_length?: number;
    pricing?: OpenRouterPricing;
    description?: string;
    architecture?: {
        modality: string;
        tokenizer: string;
        instruct_type?: string | null;
    };
    top_provider?: {
        name: string;
        max_completion_tokens?: number | null;
    };
    per_request_limits?: {
        prompt_tokens?: string;
        completion_tokens?: string;
    };
}

/**
 * OpenRouter API models list response
 */
export interface OpenRouterModelsResponse {
    data: OpenRouterModelResponse[];
}

/**
 * OpenAI API model response
 * Represents a model returned from OpenAI's /v1/models endpoint
 */
export interface OpenAIModelResponse {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}

/**
 * OpenAI API models list response
 */
export interface OpenAIModelsResponse {
    object: string;
    data: OpenAIModelResponse[];
}
