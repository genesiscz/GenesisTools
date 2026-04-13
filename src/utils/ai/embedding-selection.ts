import { findModel, getEmbedModelsForType, getEmbeddingProviderTypes } from "./ModelRegistry";
import { getProvider } from "./providers";
import type { ModelEntry } from "./types";
import * as p from "@clack/prompts";
import pc from "picocolors";

// ── Types ──

type EmbedProvider = ModelEntry["provider"];

export interface EmbeddingProviderOption {
    provider: EmbedProvider;
    model: string;
    label: string;
    dimensions: number;
    gpu: string;
    available: boolean;
}

export interface EmbeddingSelection {
    provider: EmbedProvider;
    model: string;
}

// ── Discovery ──

const GPU_LABELS: Record<EmbedProvider, string> = {
    ollama: "Metal GPU",
    coreml: "Neural Engine",
    darwinkit: "on-device",
    "local-hf": "CPU/MPS",
    cloud: "Cloud",
    google: "Cloud",
};

export async function discoverEmbeddingProviders(
    type: "mail" | "code" | "chat" | "files" = "mail"
): Promise<EmbeddingProviderOption[]> {
    const providerTypes = getEmbeddingProviderTypes();
    const models = getEmbedModelsForType(type);

    const availabilityMap = new Map<EmbedProvider, boolean>();

    await Promise.all(
        [...providerTypes].map(async (provType) => {
            const prov = getProvider(provType);

            if (prov.supports("embed")) {
                availabilityMap.set(provType, await prov.isAvailable());
            }
        })
    );

    return models.map((model) => ({
        provider: model.provider,
        model: model.id,
        label: `${model.name} (${model.dimensions ?? "?"}d, ${GPU_LABELS[model.provider]})`,
        dimensions: model.dimensions ?? 0,
        gpu: GPU_LABELS[model.provider],
        available: availabilityMap.get(model.provider) ?? false,
    }));
}

// ── Interactive selection ──

export async function selectEmbeddingProvider(options?: {
    type?: "mail" | "code" | "chat" | "files";
}): Promise<EmbeddingSelection | null> {
    const type = options?.type ?? "mail";
    const allProviders = await discoverEmbeddingProviders(type);
    const available = allProviders.filter((opt) => opt.available);

    const unavailableTypes = new Set(
        allProviders.filter((opt) => !opt.available).map((opt) => opt.provider)
    );

    if (unavailableTypes.has("ollama")) {
        p.log.warning(
            `Ollama is not running. For best performance:\n` +
                `  ${pc.dim("$")} ollama serve\n` +
                `  ${pc.dim("$")} ollama pull nomic-embed-text`
        );
    }

    if (available.length === 0) {
        p.log.error("No embedding providers available. Install Ollama or set OPENAI_API_KEY.");
        process.exit(1);
    }

    const promptOptions = available.map((opt, i) => ({
        value: { provider: opt.provider, model: opt.model },
        label: opt.label,
        hint: i === 0 ? "recommended" : undefined,
    }));

    const choice = await p.select({
        message: "Embedding provider",
        options: promptOptions,
    });

    if (p.isCancel(choice)) {
        return null;
    }

    return choice;
}

export async function selectEmbeddingModel(
    provider: string,
    type: "mail" | "code" | "chat" | "files" = "mail"
): Promise<string | null> {
    const allModels = getEmbedModelsForType(type);
    const providerModels = allModels.filter((m) => m.provider === provider);

    if (providerModels.length === 0) {
        p.log.error(`No embedding models found for provider: ${provider}`);
        return null;
    }

    if (providerModels.length === 1) {
        return providerModels[0].id;
    }

    const options = providerModels.map((m) => ({
        value: m.id,
        label: `${m.name} (${m.dimensions ?? "?"}${m.dimensions ? "-dim" : ""})`,
        hint: m.description,
    }));

    const choice = await p.select({
        message: `Model for ${provider}`,
        options,
    });

    if (p.isCancel(choice)) {
        return null;
    }

    return choice;
}

// ── Logging ──

export function logProviderChoice(provider: string, model: string): void {
    const entry = findModel(model);
    const dims = entry?.dimensions;
    const gpu = GPU_LABELS[provider as EmbedProvider] ?? provider;
    const suffix = dims ? ` (${dims}-dim, ${gpu})` : "";
    const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
    p.log.info(`Using model: ${pc.bold(`${providerName} ${model}`)}${suffix}`);
}

export function getDefaultModel(provider: string, type: "mail" | "code" | "chat" | "files" = "mail"): string {
    const models = getEmbedModelsForType(type);
    const first = models.find((m) => m.provider === provider);
    return first?.id ?? provider;
}
