import type { ModelInfo, ProviderConfig } from "@ask/types";

interface ResolvedModels {
    models: ModelInfo[];
    config: ProviderConfig;
}

/**
 * Fetch models and pricing for a known provider.
 * Shared by all API-key and subscription resolvers to avoid duplication.
 */
export async function resolveModelsWithPricing(providerName: string): Promise<ResolvedModels> {
    const { getProviderConfigs, KNOWN_MODELS } = await import("@ask/providers/providers");
    const config = getProviderConfigs().find((c) => c.name === providerName);

    if (!config) {
        throw new Error(`${providerName} provider config missing from PROVIDER_CONFIGS`);
    }

    const knownModels = KNOWN_MODELS[providerName as keyof typeof KNOWN_MODELS];

    if (!knownModels) {
        return { models: [], config };
    }

    const { dynamicPricingManager } = await import("@ask/providers/DynamicPricing");
    const models: ModelInfo[] = await Promise.all(
        knownModels.map(async (m) => ({
            ...m,
            provider: providerName,
            pricing: (await dynamicPricingManager.getPricing(providerName, m.id)) || undefined,
        })),
    );

    return { models, config };
}
