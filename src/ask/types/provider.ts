import type { ProviderV2 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import type { ModelInfo } from "./chat";

/**
 * OpenAI has 3 text generation API endpoints:
 *
 * 1. /v1/chat/completions (Chat API) — Used by .chat()
 *    Models: gpt-4o, gpt-4-turbo, gpt-3.5-turbo, o1, o3, gpt-5, etc.
 *    This is the default and most common endpoint.
 *
 * 2. /v1/responses (Responses API) — Used by .responses() / .languageModel()
 *    Models: Everything in Chat API + gpt-5-codex, gpt-5-pro
 *    Newer API with tool results, web search, etc.
 *    Warning: .languageModel() defaults here in ai-sdk v5+
 *
 * 3. /v1/completions (Completions API) — Used by .completion()
 *    Models: gpt-3.5-turbo-instruct only (legacy)
 *
 * We prefer .chat() because it's the most established and widely tested.
 * Models like gpt-5-codex/gpt-5-pro ONLY work on the Responses API.
 * See: src/ask/docs/selecting-mode-decision.md for full details.
 */

// Patterns that indicate a model needs the Responses API instead of Chat API
const RESPONSES_ONLY_PATTERNS = ["codex", "-pro"];

export function getLanguageModel(provider: ProviderV2, modelId: string): LanguageModel {
    const id = modelId.toLowerCase();

    // For OpenAI-like providers that expose both .chat() and .responses()
    if ("chat" in provider && typeof provider.chat === "function") {
        // Check if this model needs the Responses API endpoint
        if (
            "responses" in provider &&
            typeof provider.responses === "function" &&
            RESPONSES_ONLY_PATTERNS.some((p) => id.includes(p))
        ) {
            return (provider.responses as (id: string) => LanguageModel)(modelId);
        }

        // Default: use Chat API
        return (provider.chat as (id: string) => LanguageModel)(modelId);
    }

    // Non-OpenAI providers: use the standard .languageModel()
    return provider.languageModel(modelId);
}

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
    provider: ProviderV2;
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
