import type { AIConfig } from "../AIConfig";
import type { AIProvider, AIProviderType, AITask } from "../types";
import { AICloudProvider } from "./AICloudProvider";
import { AICoreMLProvider } from "./AICoreMLProvider";
import { AIDarwinKitProvider } from "./AIDarwinKitProvider";
import { AIGoogleProvider } from "./AIGoogleProvider";
import { AILocalProvider } from "./AILocalProvider";
import { AIMacOSTextToSpeechProvider } from "./AIMacOSTextToSpeechProvider";
import { AIOllamaProvider } from "./AIOllamaProvider";
import { AIOpenAITextToSpeechProvider } from "./openai/AIOpenAITextToSpeechProvider";
import { AIXAITextToSpeechProvider } from "./xai/AIXAITextToSpeechProvider";
import { AIXAITranscriptionProvider } from "./xai/AIXAITranscriptionProvider";

const providers = new Map<AIProviderType, AIProvider>();

/** @deprecated Use task-specific accessors: getTranscriptionProvider, getTextToSpeechProvider, etc. */
export function getProvider(type: AIProviderType): AIProvider {
    const existing = providers.get(type);

    if (existing) {
        return existing;
    }

    let provider: AIProvider;

    switch (type) {
        case "cloud":
            provider = new AICloudProvider("auto");
            break;
        case "openai":
            provider = new AICloudProvider("openai");
            break;
        case "groq":
            provider = new AICloudProvider("groq");
            break;
        case "openrouter":
            provider = new AICloudProvider("openrouter");
            break;
        case "assemblyai":
            provider = new AICloudProvider("assemblyai");
            break;
        case "deepgram":
            provider = new AICloudProvider("deepgram");
            break;
        case "gladia":
            provider = new AICloudProvider("gladia");
            break;
        case "local-hf":
            provider = new AILocalProvider();
            break;
        case "darwinkit":
            provider = new AIDarwinKitProvider();
            break;
        case "coreml":
            provider = new AICoreMLProvider({
                modelId: "coreml-contextual",
                dimensions: 768,
                contextual: true,
                language: "en",
            });
            break;
        case "ollama":
            provider = new AIOllamaProvider();
            break;
        case "google":
            provider = new AIGoogleProvider();
            break;
        case "xai":
            provider = new AIXAITextToSpeechProvider();
            break;
        case "macos":
            provider = new AIMacOSTextToSpeechProvider();
            break;
        default:
            throw new Error(`Unknown provider type: ${type}`);
    }

    providers.set(type, provider);
    return provider;
}

export async function getProviderForTask(task: AITask, config: AIConfig): Promise<AIProvider> {
    const preferred = config.getTaskProvider(task);
    // Route through the task-specific accessor first so per-task class splits work
    // (e.g. xai has separate AIXAITranscriptionProvider + AIXAITextToSpeechProvider —
    // getProvider returns only the TTS one).
    let provider: AIProvider;

    try {
        if (task === "transcribe") {
            provider = getTranscriptionProvider(preferred);
        } else if (task === "tts") {
            provider = getTextToSpeechProvider(preferred);
        } else {
            provider = getProvider(preferred);
        }
    } catch {
        provider = getProvider(preferred);
    }

    if (provider.supports(task) && (await provider.isAvailable())) {
        return provider;
    }

    // GPU-capable providers first: Ollama (Metal/CUDA), CoreML (Neural Engine), then CPU fallbacks
    const fallbackOrder: AIProviderType[] = [
        "ollama",
        "coreml",
        "darwinkit",
        "local-hf",
        "cloud",
        "google",
        "assemblyai",
        "deepgram",
        "gladia",
    ];

    for (const type of fallbackOrder) {
        if (type === preferred) {
            continue;
        }

        const fallback = getProvider(type);

        if (fallback.supports(task) && (await fallback.isAvailable())) {
            return fallback;
        }
    }

    throw new Error(
        `No available provider supports task "${task}". ` +
            `Preferred: ${preferred}. Tried fallbacks: ${fallbackOrder.join(", ")}.`
    );
}

const customProviderCache = new Map<string, AIProvider>();

function getOrCacheCustom<T extends AIProvider>(key: string, factory: () => T): T {
    const existing = customProviderCache.get(key) as T | undefined;

    if (existing) {
        return existing;
    }

    const created = factory();
    customProviderCache.set(key, created);
    return created;
}

export function getAllProviders(): AIProvider[] {
    const types: AIProviderType[] = [
        "darwinkit",
        "local-hf",
        "cloud",
        "openai",
        "groq",
        "openrouter",
        "assemblyai",
        "deepgram",
        "gladia",
        "ollama",
        "google",
        "coreml",
        "xai",
        "macos",
    ];
    const list = types.map((type) => getProvider(type));
    // Add per-task providers that don't surface through getProvider().
    list.push(getOrCacheCustom("xai-stt", () => new AIXAITranscriptionProvider()));
    list.push(getOrCacheCustom("openai-tts", () => new AIOpenAITextToSpeechProvider()));
    return list;
}

export function disposeAll(): void {
    for (const provider of providers.values()) {
        provider.dispose?.();
    }

    providers.clear();
}

import { CLOUD_PROVIDER_TYPES } from "@app/utils/config/ai.types";
import type {
    AIEmbeddingProvider,
    AISummarizationProvider,
    AITextToSpeechProvider,
    AITranscriptionProvider,
    AITranslationProvider,
} from "../types";

/**
 * Return all registered providers that support `task`, optionally filtered by kind.
 * Note: does NOT call isAvailable() — caller decides whether to filter further.
 */
export function getProvidersForTask(task: AITask, filter?: { kind?: "local" | "cloud" | "any" }): AIProvider[] {
    const all = getAllProviders().filter((p) => p.supports(task));
    const kind = filter?.kind ?? "any";

    if (kind === "any") {
        return all;
    }

    if (kind === "cloud") {
        return all.filter((p) => CLOUD_PROVIDER_TYPES.has(p.type));
    }

    return all.filter((p) => !CLOUD_PROVIDER_TYPES.has(p.type));
}

export function getTranscriptionProvider(type: AIProviderType): AITranscriptionProvider {
    if (type === "xai") {
        return getOrCacheCustom("xai-stt", () => new AIXAITranscriptionProvider());
    }

    const p = getProvider(type);

    if (!isTranscriptionProvider(p)) {
        throw new Error(`Provider "${type}" does not implement AITranscriptionProvider.`);
    }

    return p;
}

export function getTextToSpeechProvider(type: AIProviderType): AITextToSpeechProvider {
    if (type === "openai") {
        return getOrCacheCustom("openai-tts", () => new AIOpenAITextToSpeechProvider());
    }

    const p = getProvider(type);

    if (!isTextToSpeechProvider(p)) {
        throw new Error(`Provider "${type}" does not implement AITextToSpeechProvider.`);
    }

    return p;
}

export function getEmbeddingProvider(type: AIProviderType): AIEmbeddingProvider {
    const p = getProvider(type);

    if (!isEmbeddingProvider(p)) {
        throw new Error(`Provider "${type}" does not implement AIEmbeddingProvider.`);
    }

    return p;
}

export function getTranslationProvider(type: AIProviderType): AITranslationProvider {
    const p = getProvider(type);

    if (!isTranslationProvider(p)) {
        throw new Error(`Provider "${type}" does not implement AITranslationProvider.`);
    }

    return p;
}

export function getSummarizationProvider(type: AIProviderType): AISummarizationProvider {
    const p = getProvider(type);

    if (!isSummarizationProvider(p)) {
        throw new Error(`Provider "${type}" does not implement AISummarizationProvider.`);
    }

    return p;
}

function isTranscriptionProvider(p: AIProvider): p is AITranscriptionProvider {
    return typeof (p as AITranscriptionProvider).transcribe === "function";
}

function isTextToSpeechProvider(p: AIProvider): p is AITextToSpeechProvider {
    return typeof (p as AITextToSpeechProvider).synthesize === "function";
}

function isEmbeddingProvider(p: AIProvider): p is AIEmbeddingProvider {
    return typeof (p as AIEmbeddingProvider).embed === "function";
}

function isTranslationProvider(p: AIProvider): p is AITranslationProvider {
    return typeof (p as AITranslationProvider).translate === "function";
}

function isSummarizationProvider(p: AIProvider): p is AISummarizationProvider {
    return typeof (p as AISummarizationProvider).summarize === "function";
}

export { AICloudProvider } from "./AICloudProvider";
export { AICoreMLProvider } from "./AICoreMLProvider";
export { AIDarwinKitProvider } from "./AIDarwinKitProvider";
export { AIGoogleProvider } from "./AIGoogleProvider";
export { AILocalProvider } from "./AILocalProvider";
export { AIMacOSTextToSpeechProvider } from "./AIMacOSTextToSpeechProvider";
export { AIOllamaProvider } from "./AIOllamaProvider";
export { AIOpenAITextToSpeechProvider } from "./openai/AIOpenAITextToSpeechProvider";
export { AIXAITextToSpeechProvider } from "./xai/AIXAITextToSpeechProvider";
export { AIXAITranscriptionProvider } from "./xai/AIXAITranscriptionProvider";
