import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider } from "@ask/types";

/**
 * Knows how to resolve an account of a specific provider type
 * into a DetectedProvider (SDK instance + models + metadata).
 */
export interface AccountResolver {
    readonly providerType: AIProvider;
    resolve(accountName: string): Promise<DetectedProvider>;
}

const registry = new Map<AIProvider, AccountResolver>();

export function registerResolver(resolver: AccountResolver): void {
    registry.set(resolver.providerType, resolver);
}

export function getResolver(providerType: AIProvider): AccountResolver {
    const resolver = registry.get(providerType);

    if (!resolver) {
        throw new Error(
            `No resolver registered for provider type "${providerType}". ` +
                `Available: ${[...registry.keys()].join(", ")}`
        );
    }

    return resolver;
}

/**
 * Bootstrap all resolvers. Called once on first AIAccount.provider() call.
 * Uses dynamic imports to avoid circular deps and keep startup fast.
 */
let initialized = false;

export async function ensureResolversInitialized(): Promise<void> {
    if (initialized) {
        return;
    }

    const [{ AnthropicSubResolver }, { AnthropicApiKeyResolver }, { OpenAIApiKeyResolver }, { HuggingFaceResolver }] =
        await Promise.all([
            import("./AnthropicSubResolver"),
            import("./AnthropicApiKeyResolver"),
            import("./OpenAIApiKeyResolver"),
            import("./HuggingFaceResolver"),
        ]);

    registerResolver(new AnthropicSubResolver());
    registerResolver(new AnthropicApiKeyResolver());
    registerResolver(new OpenAIApiKeyResolver());
    registerResolver(new HuggingFaceResolver());

    initialized = true;
}

/** Reset for testing */
export function resetResolvers(): void {
    registry.clear();
    initialized = false;
}
