import type { AIConfig } from "../AIConfig";
import type { AIProvider, AIProviderType, AITask } from "../types";
import { AICloudProvider } from "./AICloudProvider";
import { AICoreMLProvider } from "./AICoreMLProvider";
import { AIDarwinKitProvider } from "./AIDarwinKitProvider";
import { AIGoogleProvider } from "./AIGoogleProvider";
import { AILocalProvider } from "./AILocalProvider";
import { AIOllamaProvider } from "./AIOllamaProvider";

const providers = new Map<AIProviderType, AIProvider>();

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
        default:
            throw new Error(`Unknown provider type: ${type}`);
    }

    providers.set(type, provider);
    return provider;
}

export async function getProviderForTask(task: AITask, config: AIConfig): Promise<AIProvider> {
    const preferred = config.getTaskProvider(task);
    const provider = getProvider(preferred);

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
    ];
    return types.map((type) => getProvider(type));
}

export function disposeAll(): void {
    for (const provider of providers.values()) {
        provider.dispose?.();
    }

    providers.clear();
}

export { AICloudProvider } from "./AICloudProvider";
export { AICoreMLProvider } from "./AICoreMLProvider";
export { AIDarwinKitProvider } from "./AIDarwinKitProvider";
export { AIGoogleProvider } from "./AIGoogleProvider";
export { AILocalProvider } from "./AILocalProvider";
export { AIOllamaProvider } from "./AIOllamaProvider";
