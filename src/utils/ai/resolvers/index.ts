import type { DetectedProvider } from "@genesiscz/utils/ask/types";
import type { AIProvider } from "@genesiscz/utils/config/ai.types";

/**
 * Knows how to resolve an account of a specific provider type
 * into a DetectedProvider (SDK instance + models + metadata).
 */
export interface ResolveAccountOptions {
    /**
     * Read credentials without rotating them. Set by diagnostic callers
     * (`tools ai config doctor --live`), never by real use: a subscription
     * refresh token is single-use, so a probe that refreshes spends a grant it
     * cannot always persist.
     */
    noRefresh?: boolean;
    /**
     * The auth file the CALLER already holds, for subscription providers that
     * keep credentials in a CLI's file. Supplying it skips the resolver's own
     * lookup-by-name, so a binding is decided by the context it was handed
     * rather than by re-querying global config: an isolated account object can
     * bind, and two accounts sharing a name cannot resolve to each other.
     */
    authFile?: string;
}

export interface AccountResolver {
    readonly providerType: AIProvider;
    resolve(accountName: string, options?: ResolveAccountOptions): Promise<DetectedProvider>;
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

    const [
        { AnthropicSubResolver },
        { AnthropicApiKeyResolver },
        { OpenAIApiKeyResolver },
        { OpenAISubResolver },
        { HuggingFaceResolver },
        { GrokSubResolver },
    ] = await Promise.all([
        import("./AnthropicSubResolver"),
        import("./AnthropicApiKeyResolver"),
        import("./OpenAIApiKeyResolver"),
        import("./OpenAISubResolver"),
        import("./HuggingFaceResolver"),
        import("./GrokSubResolver"),
    ]);

    registerResolver(new AnthropicSubResolver());
    registerResolver(new AnthropicApiKeyResolver());
    registerResolver(new OpenAIApiKeyResolver());
    registerResolver(new OpenAISubResolver());
    registerResolver(new HuggingFaceResolver());
    registerResolver(new GrokSubResolver());

    initialized = true;
}

/** Reset for testing */
export function resetResolvers(): void {
    registry.clear();
    initialized = false;
}
