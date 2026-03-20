import { formatTable } from "@app/utils/table";

export interface ModelInfo {
    id: string;
    name: string;
    params: string;
    dimensions: number;
    ramGB: number;
    speed: "fast" | "medium" | "slow";
    license: string;
    provider: "local-hf" | "cloud" | "darwinkit";
    bestFor: string[];
    description: string;
    installCmd?: string;
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
    },
];

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
