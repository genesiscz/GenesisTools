import { formatTable } from "@app/utils/table";

export interface ModelInfo {
    id: string;
    name: string;
    params: string;
    dimensions: number;
    ramGB: number;
    speed: "fast" | "medium" | "slow";
    license: string;
    provider: "local-hf" | "cloud" | "darwinkit" | "coreml" | "ollama";
    bestFor: string[];
    description: string;
    installCmd?: string;
    /** Max context window in tokens. Used for pre-truncation before embedding. */
    contextLength?: number;
    /**
     * Estimated characters per token. Used to convert contextLength (tokens) to max chars.
     * Default: 4 for English prose. Use 1.5-2 for code (dense syntax: {, }, ;, =).
     */
    charsPerToken?: number;
    /**
     * Task prefixes for asymmetric retrieval models.
     * Document prefix is prepended during indexing; query prefix during search.
     * E.g., nomic-embed-text uses "search_document: " / "search_query: ".
     */
    taskPrefix?: {
        document: string;
        query: string;
    };
}

export const MODEL_REGISTRY: ModelInfo[] = [
    {
        id: "jinaai/CodeRankEmbed",
        name: "CodeRankEmbed",
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
        params: "572M",
        dimensions: 1024,
        ramGB: 2.5,
        speed: "fast",
        license: "Apache-2.0",
        provider: "local-hf",
        bestFor: ["code", "general", "mail"],
        description: "Strong all-rounder. Code + natural language. Matryoshka dimensions.",
        contextLength: 8192,
        charsPerToken: 3,
        taskPrefix: { document: "search_document: ", query: "search_query: " },
    },
    {
        id: "voyage-code-3",
        name: "VoyageCode3",
        params: "API",
        dimensions: 1024,
        ramGB: 0,
        speed: "medium",
        license: "Proprietary",
        provider: "cloud",
        bestFor: ["code"],
        description: "Highest quality code embeddings. Requires VOYAGE_API_KEY.",
        contextLength: 16000,
        charsPerToken: 2,
    },
    {
        id: "text-embedding-3-small",
        name: "OpenAI Embed 3 Small",
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
        id: "darwinkit",
        name: "DarwinKit NL",
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
        params: "built-in",
        dimensions: 512,
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
];

/**
 * Known context lengths for embedding models (tokens).
 * Used as fallback when a model isn't in MODEL_REGISTRY.
 * Sources: model cards, Ollama docs, SocratiCode embedding-config.ts.
 */
export const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
    // Ollama models
    "nomic-embed-text": 2048,
    "mxbai-embed-large": 512,
    "snowflake-arctic-embed": 512,
    "all-minilm": 256,
    // OpenAI models
    "text-embedding-3-small": 8191,
    "text-embedding-3-large": 8191,
    "text-embedding-ada-002": 8191,
    // HuggingFace models
    "Xenova/all-MiniLM-L6-v2": 256,
    "jinaai/jina-embeddings-v3": 8192,
    "jinaai/CodeRankEmbed": 512,
    "nomic-ai/nomic-embed-code-v1": 2048,
    // Google
    "gemini-embedding-001": 2048,
};

const DEFAULT_CONTEXT_LENGTH = 512;
const DEFAULT_CHARS_PER_TOKEN = 3;

/**
 * Get the max character count for embedding text with a given model.
 * Looks up the model in MODEL_REGISTRY first, then MODEL_CONTEXT_LENGTHS fallback.
 */
export function getMaxEmbedChars(modelId: string): number {
    // Try registry first
    const registered = MODEL_REGISTRY.find((m) => m.id === modelId);

    if (registered?.contextLength) {
        const cpt = registered.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
        return registered.contextLength * cpt;
    }

    // Fallback lookup (strip :tag for Ollama-style model names)
    const baseId = modelId.replace(/:.*$/, "");
    const contextLength = MODEL_CONTEXT_LENGTHS[baseId] ?? MODEL_CONTEXT_LENGTHS[modelId];

    if (contextLength) {
        return contextLength * DEFAULT_CHARS_PER_TOKEN;
    }

    return DEFAULT_CONTEXT_LENGTH * DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Task prefixes for known embedding models (used for asymmetric retrieval).
 * Fallback for models not in MODEL_REGISTRY.
 */
export const TASK_PREFIXES: Record<string, { document: string; query: string }> = {
    "nomic-embed-text": { document: "search_document: ", query: "search_query: " },
    "nomic-ai/nomic-embed-code-v1": { document: "search_document: ", query: "search_query: " },
    "nomic-embed-code": { document: "search_document: ", query: "search_query: " },
};

/**
 * Get the task prefix config for a model, or null if the model doesn't use task prefixes.
 */
export function getTaskPrefix(modelId: string): { document: string; query: string } | null {
    const registered = MODEL_REGISTRY.find((m) => m.id === modelId);

    if (registered?.taskPrefix) {
        return registered.taskPrefix;
    }

    const baseId = modelId.replace(/:.*$/, "");
    return TASK_PREFIXES[baseId] ?? TASK_PREFIXES[modelId] ?? null;
}

/**
 * Returns models sorted with best matches for the given type first.
 */
export function getModelsForType(type: "code" | "files" | "mail" | "chat"): ModelInfo[] {
    const category = type === "code" || type === "files" ? "code" : type === "mail" ? "mail" : "general";

    return [...MODEL_REGISTRY].sort((a, b) => {
        const aMatch = a.bestFor.includes(category) ? 0 : 1;
        const bMatch = b.bestFor.includes(category) ? 0 : 1;
        return aMatch - bMatch;
    });
}

/**
 * Formats the model list as a CLI-friendly table.
 */
export function formatModelTable(models: ModelInfo[]): string {
    const headers = ["Name", "Params", "Dims", "RAM", "Speed", "License", "Best For"];
    const rows = models.map((m) => [
        m.name,
        m.params,
        String(m.dimensions),
        m.ramGB > 0 ? `${m.ramGB}GB` : m.provider === "cloud" ? "cloud" : "built-in",
        m.speed,
        m.license,
        m.bestFor.join(", "),
    ]);

    return formatTable(rows, headers, { alignRight: [2, 3] });
}
