import type { ProviderConfig } from "@genesiscz/utils/ask/types";

/**
 * The pre-plugin provider wiring, kept alive until the plugin registry owns it.
 *
 * This file used to also carry `KNOWN_MODELS`, a hand-maintained model list that
 * nobody refreshed: it still advertised Opus 4.6 as Anthropic's newest model and
 * Gemini 1.5 as Google's, so `tools ask models` showed a catalog two generations
 * stale. Model facts now come from `@genesiscz/utils/ai/catalog`; what is left
 * here is credential/endpoint wiring, unchanged, waiting for its own move into
 * the provider plugins.
 */

export const PROVIDER_CONFIGS: ProviderConfig[] = [
    // OpenAI - High priority, reliable
    {
        name: "openai",
        type: "openai",
        envKey: "OPENAI_API_KEY",
        import: "@ai-sdk/openai",
        description: "OpenAI GPT models",
        priority: 1,
    },

    // Groq - Very fast inference, high priority
    {
        name: "groq",
        type: "groq",
        envKey: "GROQ_API_KEY",
        import: "@ai-sdk/groq",
        description: "Groq (very fast inference)",
        priority: 2,
    },

    // OpenRouter - Aggregates many providers, medium priority
    {
        name: "openrouter",
        type: "openai-compatible",
        envKey: "OPENROUTER_API_KEY",
        baseURL: "https://openrouter.ai/api/v1",
        import: "@ai-sdk/openai",
        description: "OpenRouter (100+ models)",
        priority: 3,
    },

    // Anthropic - High quality models
    {
        name: "anthropic",
        type: "anthropic",
        envKey: "ANTHROPIC_API_KEY",
        import: "@ai-sdk/anthropic",
        description: "Anthropic Claude models",
        priority: 4,
    },

    // Google - Gemini models
    {
        name: "google",
        type: "google",
        envKey: "GOOGLE_API_KEY",
        import: "@ai-sdk/google",
        description: "Google Gemini models",
        priority: 5,
    },

    // xAI - Grok models
    {
        name: "xai",
        type: "openai-compatible",
        envKey: "X_AI_API_KEY",
        baseURL: "https://api.x.ai/v1",
        import: "@ai-sdk/openai",
        description: "xAI Grok models",
        priority: 6,
    },

    // Jina AI - Good for embeddings/search
    {
        name: "jinaai",
        type: "openai-compatible",
        envKey: "JINA_AI_API_KEY",
        baseURL: "https://api.jina.ai/v1",
        import: "@ai-sdk/openai",
        description: "Jina AI models",
        priority: 7,
    },
];

export function getProviderConfig(name: string): ProviderConfig | undefined {
    return PROVIDER_CONFIGS.find((config) => config.name === name);
}

export function getProviderConfigs(): ProviderConfig[] {
    return [...PROVIDER_CONFIGS].sort((a, b) => a.priority - b.priority);
}
