import type { ProviderConfig } from "@ask/types";

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

export const TRANSCRIPTION_PROVIDERS = [
    // Groq - Fast, high quality, 25MB limit
    {
        name: "groq",
        envKey: "GROQ_API_KEY",
        model: "whisper-large-v3",
        maxFileSize: 25 * 1024 * 1024, // 25MB
        priority: 1,
    },

    // OpenRouter - Various models, 25MB limit
    {
        name: "openrouter",
        envKey: "OPENROUTER_API_KEY",
        model: "openai/whisper-1",
        maxFileSize: 25 * 1024 * 1024, // 25MB
        priority: 2,
    },

    // OpenAI - Original Whisper, 25MB limit
    {
        name: "openai",
        envKey: "OPENAI_API_KEY",
        model: "whisper-1",
        maxFileSize: 25 * 1024 * 1024, // 25MB
        priority: 3,
    },

    // AssemblyAI - Professional, supports large files
    {
        name: "assemblyai",
        envKey: "ASSEMBLYAI_API_KEY",
        model: "best",
        maxFileSize: 100 * 1024 * 1024, // 100MB+
        priority: 4,
    },

    // Deepgram - Fast, supports large files
    {
        name: "deepgram",
        envKey: "DEEPGRAM_API_KEY",
        model: "nova-3",
        maxFileSize: 100 * 1024 * 1024, // 100MB+
        priority: 5,
    },

    // Gladia - Good quality, supports large files
    {
        name: "gladia",
        envKey: "GLADIA_API_KEY",
        model: "default",
        maxFileSize: 100 * 1024 * 1024, // 100MB+
        priority: 6,
    },
];

// Known model configurations for providers that don't have model discovery APIs
export const KNOWN_MODELS = {
    openai: [
        {
            id: "gpt-4-turbo",
            name: "GPT-4 Turbo",
            contextWindow: 128000,
            capabilities: ["chat", "function-calling"],
        },
        {
            id: "gpt-4",
            name: "GPT-4",
            contextWindow: 8192,
            capabilities: ["chat", "function-calling"],
        },
        {
            id: "gpt-3.5-turbo",
            name: "GPT-3.5 Turbo",
            contextWindow: 16384,
            capabilities: ["chat"],
        },
        {
            id: "gpt-4o",
            name: "GPT-4o",
            contextWindow: 128000,
            capabilities: ["chat", "vision", "function-calling"],
        },
        {
            id: "gpt-4o-mini",
            name: "GPT-4o Mini",
            contextWindow: 128000,
            capabilities: ["chat", "vision", "function-calling"],
        },
    ],
    anthropic: [
        {
            id: "claude-3-5-sonnet-20241022",
            name: "Claude 3.5 Sonnet (Latest)",
            contextWindow: 200000,
            capabilities: ["chat", "vision", "function-calling"],
        },
        {
            id: "claude-3-opus-20240229",
            name: "Claude 3 Opus",
            contextWindow: 200000,
            capabilities: ["chat", "vision", "function-calling"],
        },
        {
            id: "claude-3-sonnet-20240229",
            name: "Claude 3 Sonnet",
            contextWindow: 200000,
            capabilities: ["chat", "vision", "function-calling"],
        },
        {
            id: "claude-3-haiku-20240307",
            name: "Claude 3 Haiku",
            contextWindow: 200000,
            capabilities: ["chat", "vision", "function-calling"],
        },
    ],
    groq: [
        {
            id: "llama-3.1-405b-reasoning",
            name: "Llama 3.1 405B Reasoning",
            contextWindow: 131072,
            capabilities: ["chat", "reasoning"],
        },
        {
            id: "llama-3.1-70b-versatile",
            name: "Llama 3.1 70B Versatile",
            contextWindow: 131072,
            capabilities: ["chat"],
        },
        {
            id: "llama-3.1-8b-instant",
            name: "Llama 3.1 8B Instant",
            contextWindow: 131072,
            capabilities: ["chat"],
        },
        {
            id: "mixtral-8x7b-32768",
            name: "Mixtral 8x7B",
            contextWindow: 32768,
            capabilities: ["chat"],
        },
    ],
    google: [
        {
            id: "gemini-1.5-pro-latest",
            name: "Gemini 1.5 Pro (Latest)",
            contextWindow: 2097152,
            capabilities: ["chat", "vision", "function-calling"],
        },
        {
            id: "gemini-1.5-flash-latest",
            name: "Gemini 1.5 Flash (Latest)",
            contextWindow: 1048576,
            capabilities: ["chat", "vision", "function-calling"],
        },
        {
            id: "gemini-1.0-pro",
            name: "Gemini 1.0 Pro",
            contextWindow: 32768,
            capabilities: ["chat", "function-calling"],
        },
    ],
    xai: [
        {
            id: "grok-beta",
            name: "Grok Beta",
            contextWindow: 131072,
            capabilities: ["chat", "reasoning"],
        },
    ],
    jinaai: [
        {
            id: "jina-r1",
            name: "Jina R1",
            contextWindow: 8192,
            capabilities: ["chat", "reasoning"],
        },
    ],
};

export function getProviderConfig(name: string): ProviderConfig | undefined {
    return PROVIDER_CONFIGS.find((config) => config.name === name);
}

export function getProviderConfigs(): ProviderConfig[] {
    return [...PROVIDER_CONFIGS].sort((a, b) => a.priority - b.priority);
}
