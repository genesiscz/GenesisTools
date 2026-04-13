import type { AITask } from "@app/utils/config/ai.types";
import type { ModelEntry } from "./types";

// ── Embedding models ──

const EMBED_MODELS: ModelEntry[] = [
    {
        id: "jinaai/CodeRankEmbed",
        name: "CodeRankEmbed",
        task: "embed",
        params: "137M",
        dimensions: 768,
        ramGB: 1.5,
        speed: "fast",
        license: "MIT",
        provider: "local-hf",
        bestFor: ["code"],
        description: "Smallest self-hostable code model. Fast CPU/MPS inference.",
        contextLength: 512,
        charsPerToken: 2,
    },
    {
        id: "nomic-ai/nomic-embed-code-v1",
        name: "Nomic Embed Code",
        task: "embed",
        params: "137M",
        dimensions: 768,
        ramGB: 1.5,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["code"],
        description: "Used by Tabby. Good code search quality.",
        contextLength: 2048,
        charsPerToken: 2,
        taskPrefix: { document: "search_document: ", query: "search_query: " },
    },
    {
        id: "nvidia/NV-EmbedCode-7b-v1",
        name: "NV-EmbedCode 7B",
        task: "embed",
        params: "7.1B",
        dimensions: 4096,
        ramGB: 15,
        speed: "slow",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["code"],
        description: "Highest recall. Given a bug, find which files to edit. Needs GPU/M4 Pro Max.",
        contextLength: 2048,
        charsPerToken: 2,
    },
    {
        id: "jinaai/jina-embeddings-v3",
        name: "Jina Embeddings v3",
        task: "embed",
        params: "572M",
        dimensions: 1024,
        ramGB: 2.5,
        speed: "fast",
        license: "CC-BY-NC-4.0",
        provider: "local-hf",
        bestFor: ["code", "general", "mail"],
        description: "Strong all-rounder. Code + natural language. Matryoshka dimensions. Non-commercial license!",
        contextLength: 8192,
        charsPerToken: 3,
        taskPrefix: { document: "search_document: ", query: "search_query: " },
    },
    {
        id: "text-embedding-3-small",
        name: "OpenAI Embed 3 Small",
        task: "embed",
        params: "API",
        dimensions: 1536,
        ramGB: 0,
        speed: "fast",
        license: "Proprietary",
        provider: "cloud",
        bestFor: ["general", "mail"],
        description: "General-purpose. Requires OPENAI_API_KEY.",
        contextLength: 8191,
        charsPerToken: 4,
    },
    {
        id: "text-embedding-3-large",
        name: "OpenAI Embed 3 Large",
        task: "embed",
        params: "API",
        dimensions: 3072,
        ramGB: 0,
        speed: "fast",
        license: "Proprietary",
        provider: "openai",
        bestFor: ["code", "general", "mail"],
        description: "Highest-quality OpenAI embedding. 3072 dims. Requires OPENAI_API_KEY.",
        contextLength: 8191,
        charsPerToken: 4,
    },
    {
        id: "darwinkit",
        name: "DarwinKit NL",
        task: "embed",
        params: "built-in",
        dimensions: 512,
        ramGB: 0,
        speed: "fast",
        license: "macOS",
        provider: "darwinkit",
        bestFor: ["general", "mail"],
        description: "macOS on-device. General-purpose, not code-trained. Free.",
        contextLength: 512,
        charsPerToken: 4,
    },
    {
        id: "coreml-contextual",
        name: "Apple NLContextual",
        task: "embed",
        params: "built-in",
        dimensions: 768,
        ramGB: 0,
        speed: "fast",
        license: "macOS",
        provider: "coreml",
        bestFor: ["general", "mail"],
        description: "macOS 14+ on-device BERT. GPU/Neural Engine accelerated. Contextual embeddings.",
        contextLength: 512,
        charsPerToken: 4,
    },
    {
        id: "Xenova/all-MiniLM-L6-v2",
        name: "MiniLM L6 v2",
        task: "embed",
        params: "22M",
        dimensions: 384,
        ramGB: 0.1,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["general"],
        description: "Tiny general-purpose model. NOT trained on code.",
        contextLength: 256,
        charsPerToken: 4,
    },
    {
        id: "nomic-embed-text",
        name: "Nomic Embed Text (Ollama)",
        task: "embed",
        params: "137M",
        dimensions: 768,
        ramGB: 0.3,
        speed: "fast",
        license: "Apache-2.0",
        provider: "ollama",
        bestFor: ["code", "general"],
        description: "Ollama GPU-accelerated. Best local option for code + text. Needs `ollama pull nomic-embed-text`.",
        installCmd: "ollama pull nomic-embed-text",
        contextLength: 2048,
        charsPerToken: 2,
        taskPrefix: { document: "search_document: ", query: "search_query: " },
    },
    {
        id: "all-minilm",
        name: "All-MiniLM (Ollama)",
        task: "embed",
        params: "23M",
        dimensions: 384,
        ramGB: 0.1,
        speed: "fast",
        license: "Apache-2.0",
        provider: "ollama",
        bestFor: ["general"],
        description: "Tiny and fast via Ollama. Good for quick prototyping.",
        installCmd: "ollama pull all-minilm",
        contextLength: 256,
        charsPerToken: 4,
    },
    {
        id: "mxbai-embed-large",
        name: "MxBAI Embed Large (Ollama)",
        task: "embed",
        params: "335M",
        dimensions: 1024,
        ramGB: 0.7,
        speed: "medium",
        license: "Apache-2.0",
        provider: "ollama",
        bestFor: ["general", "mail"],
        description: "High-quality general-purpose via Ollama. GPU-accelerated.",
        installCmd: "ollama pull mxbai-embed-large",
        contextLength: 512,
        charsPerToken: 3,
    },
    {
        id: "gemini-embedding-001",
        name: "Gemini Embedding 001 (Google)",
        task: "embed",
        params: "API",
        dimensions: 3072,
        ramGB: 0,
        speed: "fast",
        license: "Apache-2.0",
        provider: "google",
        bestFor: ["code", "general"],
        description: "Google free-tier embedding. 3072 dims, 2048 token context. Requires GOOGLE_API_KEY.",
        contextLength: 2048,
        charsPerToken: 3,
    },

    // Additional embedding models from ModelManager (not in indexer registry)
    {
        id: "nomic-ai/nomic-embed-text-v1.5",
        name: "nomic-embed-text-v1.5",
        task: "embed",
        params: "137M",
        dimensions: 768,
        ramGB: 0.5,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["general"],
        description: "Best English embedding, 10M+ downloads, ~300MB (English only).",
        contextLength: 2048,
        charsPerToken: 3,
        taskPrefix: { document: "search_document: ", query: "search_query: " },
    },
    {
        id: "Snowflake/snowflake-arctic-embed-l-v2.0",
        name: "snowflake-arctic-embed-l-v2.0",
        task: "embed",
        params: "568M",
        dimensions: 1024,
        ramGB: 1.2,
        speed: "medium",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["general", "mail"],
        description: "High-quality multilingual, explicitly supports Czech, ~500MB.",
        contextLength: 8192,
        charsPerToken: 3,
    },
    {
        id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        name: "paraphrase-multilingual-MiniLM-L12-v2",
        task: "embed",
        params: "118M",
        dimensions: 384,
        ramGB: 0.2,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["general", "mail"],
        description: "Fast multilingual, 50+ languages, ~117MB.",
        contextLength: 512,
        charsPerToken: 3,
    },
    {
        id: "Xenova/multilingual-e5-small",
        name: "multilingual-e5-small",
        task: "embed",
        params: "118M",
        dimensions: 384,
        ramGB: 0.2,
        speed: "fast",
        license: "MIT",
        provider: "local-hf",
        bestFor: ["general", "mail"],
        description: "100 languages incl. Czech, ~117MB — recommended multilingual default.",
        contextLength: 512,
        charsPerToken: 3,
    },
    {
        id: "onnx-community/gte-multilingual-base",
        name: "gte-multilingual-base",
        task: "embed",
        params: "306M",
        dimensions: 768,
        ramGB: 0.6,
        speed: "medium",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["general", "mail"],
        description: "Best multilingual MTEB score, ~305MB.",
        contextLength: 8192,
        charsPerToken: 3,
    },
    {
        id: "Xenova/bge-m3",
        name: "bge-m3",
        task: "embed",
        params: "568M",
        dimensions: 1024,
        ramGB: 1.2,
        speed: "medium",
        license: "MIT",
        provider: "local-hf",
        bestFor: ["general", "mail"],
        description: "Top quality multilingual, dense+sparse+colbert, ~560MB.",
        contextLength: 8192,
        charsPerToken: 3,
    },
    {
        id: "Xenova/multilingual-e5-base",
        name: "multilingual-e5-base",
        task: "embed",
        params: "278M",
        dimensions: 768,
        ramGB: 0.6,
        speed: "medium",
        license: "MIT",
        provider: "local-hf",
        bestFor: ["general", "mail"],
        description: "Mid-size multilingual, ~278MB.",
        contextLength: 512,
        charsPerToken: 3,
    },
    {
        id: "Xenova/multilingual-e5-large",
        name: "multilingual-e5-large",
        task: "embed",
        params: "560M",
        dimensions: 1024,
        ramGB: 1.2,
        speed: "slow",
        license: "MIT",
        provider: "local-hf",
        bestFor: ["general", "mail"],
        description: "Large multilingual, ~560MB.",
        contextLength: 512,
        charsPerToken: 3,
    },

    // New models
    {
        id: "ibm-granite/granite-embedding-278m-multilingual",
        name: "Granite Embedding 278M Multilingual",
        task: "embed",
        params: "278M",
        dimensions: 768,
        ramGB: 0.6,
        speed: "medium",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["mail", "general"],
        description: "Explicitly supports Czech, MIRACL 58.3.",
        contextLength: 8192,
        charsPerToken: 3,
    },
    {
        id: "snowflake-arctic-embed:137m",
        name: "Snowflake Arctic Embed 137M (Ollama)",
        task: "embed",
        params: "137M",
        dimensions: 768,
        ramGB: 0.3,
        speed: "fast",
        license: "Apache-2.0",
        provider: "ollama",
        bestFor: ["code", "mail", "general"],
        description: "Fast Ollama embedding. Good for code + general use.",
        installCmd: "ollama pull snowflake-arctic-embed:137m",
        contextLength: 8192,
        charsPerToken: 3,
    },
];

// ── Transcription models ──

const TRANSCRIBE_MODELS: ModelEntry[] = [
    {
        id: "distil-whisper/distil-large-v3",
        name: "distil-large-v3",
        task: "transcribe",
        params: "756M",
        ramGB: 1.5,
        speed: "fast",
        license: "MIT",
        provider: "local-hf",
        description: "Fastest high-quality English, ~750MB — 6x faster than large-v3 (English only).",
    },
    {
        id: "onnx-community/whisper-large-v3-turbo",
        name: "whisper-large-v3-turbo",
        task: "transcribe",
        params: "809M",
        ramGB: 2.0,
        speed: "medium",
        license: "MIT",
        provider: "local-hf",
        description: "Best multilingual speed/quality, ~1.5GB (fp16 enc + q4 dec).",
    },
    {
        id: "Xenova/whisper-large-v3",
        name: "whisper-large-v3",
        task: "transcribe",
        params: "1.5B",
        ramGB: 3.0,
        speed: "slow",
        license: "MIT",
        provider: "local-hf",
        description: "Highest multilingual quality, ~3.1GB — slow but best accuracy.",
    },
    {
        id: "onnx-community/whisper-small",
        name: "whisper-small",
        task: "transcribe",
        params: "244M",
        ramGB: 0.5,
        speed: "medium",
        license: "MIT",
        provider: "local-hf",
        description: "Good multilingual accuracy, ~244MB.",
    },
    {
        id: "onnx-community/whisper-base",
        name: "whisper-base",
        task: "transcribe",
        params: "74M",
        ramGB: 0.3,
        speed: "fast",
        license: "MIT",
        provider: "local-hf",
        description: "Balanced speed/quality, ~145MB.",
    },
    {
        id: "onnx-community/whisper-tiny",
        name: "whisper-tiny",
        task: "transcribe",
        params: "39M",
        ramGB: 0.15,
        speed: "fast",
        license: "MIT",
        provider: "local-hf",
        description: "Fastest, ~75MB.",
    },
    {
        id: "whisper-large-v3-turbo",
        name: "Groq whisper-large-v3-turbo",
        task: "transcribe",
        ramGB: 0,
        speed: "fast",
        license: "Proprietary",
        provider: "cloud",
        description: "Groq-hosted turbo transcription. Fast. Requires GROQ_API_KEY.",
    },
    {
        id: "whisper-large-v3",
        name: "Groq whisper-large-v3",
        task: "transcribe",
        ramGB: 0,
        speed: "medium",
        license: "Proprietary",
        provider: "cloud",
        description: "Groq-hosted high-quality transcription. Requires GROQ_API_KEY.",
    },
    {
        id: "whisper-1",
        name: "OpenAI whisper-1",
        task: "transcribe",
        ramGB: 0,
        speed: "medium",
        license: "Proprietary",
        provider: "cloud",
        description: "OpenAI-hosted transcription. Reliable. Requires OPENAI_API_KEY.",
    },
];

// ── Translation models ──

const TRANSLATE_MODELS: ModelEntry[] = [
    {
        id: "Xenova/opus-mt-cs-en",
        name: "opus-mt-cs-en",
        task: "translate",
        params: "298M",
        ramGB: 0.6,
        speed: "fast",
        license: "CC-BY-4.0",
        provider: "local-hf",
        description: "Czech to English, ~300MB.",
    },
    {
        id: "Xenova/opus-mt-en-cs",
        name: "opus-mt-en-cs",
        task: "translate",
        params: "298M",
        ramGB: 0.6,
        speed: "fast",
        license: "CC-BY-4.0",
        provider: "local-hf",
        description: "English to Czech, ~300MB.",
    },
    {
        id: "Xenova/nllb-200-distilled-600M",
        name: "nllb-200-distilled-600M",
        task: "translate",
        params: "600M",
        ramGB: 2.4,
        speed: "medium",
        license: "CC-BY-NC-4.0",
        provider: "local-hf",
        description: "200 languages (use ces_Latn for Czech), ~2.4GB.",
    },
    {
        id: "Xenova/m2m100_418M",
        name: "m2m100_418M",
        task: "translate",
        params: "418M",
        ramGB: 1.8,
        speed: "medium",
        license: "MIT",
        provider: "local-hf",
        description: "100 languages, lighter than NLLB, ~1.8GB.",
    },
];

// ── Summarization models ──

const SUMMARIZE_MODELS: ModelEntry[] = [
    {
        id: "Xenova/distilbart-cnn-6-6",
        name: "distilbart-cnn-6-6",
        task: "summarize",
        params: "306M",
        ramGB: 0.9,
        speed: "medium",
        license: "Apache-2.0",
        provider: "local-hf",
        description: "English only, ~910MB — translate cs to en first for Czech.",
    },
];

// ── Text-to-Speech models ──

const TTS_MODELS: ModelEntry[] = [
    {
        id: "onnx-community/Kokoro-82M-v1.0-ONNX",
        name: "Kokoro-82M",
        task: "tts",
        params: "82M",
        ramGB: 0.2,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        description: "Best English TTS, ~92MB (q8) — no Czech.",
    },
    {
        id: "onnx-community/chatterbox-multilingual-ONNX",
        name: "chatterbox-multilingual",
        task: "tts",
        params: "500M",
        ramGB: 1.0,
        speed: "medium",
        license: "Apache-2.0",
        provider: "local-hf",
        description: "23 languages (DE/PL/RU but no Czech), ~500MB.",
    },
];

// ── All models ──

const ALL_MODELS: ReadonlyArray<ModelEntry> = [
    ...EMBED_MODELS,
    ...TRANSCRIBE_MODELS,
    ...TRANSLATE_MODELS,
    ...SUMMARIZE_MODELS,
    ...TTS_MODELS,
];

const modelById = new Map<string, ModelEntry>(ALL_MODELS.map((m) => [m.id, m]));

const DEFAULT_CONTEXT_LENGTH = 512;
const DEFAULT_CHARS_PER_TOKEN = 3;

/**
 * Fallback context lengths for models NOT in the registry.
 * Models already in the registry have contextLength on their entry.
 */
const FALLBACK_CONTEXT_LENGTHS: Record<string, number> = {
    "snowflake-arctic-embed": 512,
    "text-embedding-3-large": 8191,
    "text-embedding-ada-002": 8191,
};

/**
 * Fallback task prefixes for models NOT in the registry.
 * Models already in the registry have taskPrefix on their entry.
 */
const FALLBACK_TASK_PREFIXES: Record<string, { document: string; query: string }> = {
    "nomic-embed-code": { document: "search_document: ", query: "search_query: " },
};

const GPU_ORDER: Record<ModelEntry["provider"], number> = {
    ollama: 0,
    coreml: 1,
    "local-hf": 2,
    darwinkit: 3,
    cloud: 4,
    google: 5,
    openai: 6,
    groq: 7,
    openrouter: 8,
};

export function getModelsForTask(task: AITask): ReadonlyArray<ModelEntry> {
    return ALL_MODELS.filter((m) => m.task === task);
}

export function getModelsByProvider(task: AITask, provider: string): ReadonlyArray<ModelEntry> {
    return ALL_MODELS.filter((m) => m.task === task && m.provider === provider);
}

/** All distinct provider types that have embedding models registered. */
export function getEmbeddingProviderTypes(): ReadonlySet<ModelEntry["provider"]> {
    const types = new Set<ModelEntry["provider"]>();

    for (const m of ALL_MODELS) {
        if (m.task === "embed") {
            types.add(m.provider);
        }
    }

    return types;
}

export function findModel(id: string): ModelEntry | undefined {
    return modelById.get(id) ?? modelById.get(id.replace(/:.*$/, ""));
}

export function getMaxEmbedChars(modelId: string): number {
    const baseId = modelId.replace(/:.*$/, "");
    const registered = modelById.get(modelId) ?? modelById.get(baseId);

    if (registered?.contextLength) {
        const cpt = registered.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
        return registered.contextLength * cpt;
    }

    const contextLength = FALLBACK_CONTEXT_LENGTHS[baseId] ?? FALLBACK_CONTEXT_LENGTHS[modelId];

    if (contextLength) {
        return contextLength * DEFAULT_CHARS_PER_TOKEN;
    }

    return DEFAULT_CONTEXT_LENGTH * DEFAULT_CHARS_PER_TOKEN;
}

export function getTaskPrefix(modelId: string): { document: string; query: string } | null {
    const baseId = modelId.replace(/:.*$/, "");
    const registered = modelById.get(modelId) ?? modelById.get(baseId);

    if (registered?.taskPrefix) {
        return registered.taskPrefix;
    }

    return FALLBACK_TASK_PREFIXES[baseId] ?? FALLBACK_TASK_PREFIXES[modelId] ?? null;
}

export function getEmbedModelsForType(type: "code" | "files" | "mail" | "chat"): ReadonlyArray<ModelEntry> {
    const category = type === "code" || type === "files" ? "code" : type === "mail" ? "mail" : "general";

    return [...EMBED_MODELS].sort((a, b) => {
        const aMatch = a.bestFor?.includes(category) ? 0 : 1;
        const bMatch = b.bestFor?.includes(category) ? 0 : 1;

        if (aMatch !== bMatch) {
            return aMatch - bMatch;
        }

        return GPU_ORDER[a.provider] - GPU_ORDER[b.provider];
    });
}
