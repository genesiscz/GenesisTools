import type { ModelInfo, ProviderConfig } from "@ask/types";

interface ResolvedModels {
    models: ModelInfo[];
    config: ProviderConfig;
}

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
    { pattern: /mini/i, category: "mini" },
    { pattern: /haiku/i, category: "haiku" },
    { pattern: /sonnet/i, category: "sonnet" },
    { pattern: /opus/i, category: "opus" },
    { pattern: /^gpt-(?:4o|4-turbo|4\b|5\b)/i, category: "standard" },
    { pattern: /^o[13]-/i, category: "standard" },
];

function inferCategory(modelId: string): string | undefined {
    for (const { pattern, category } of CATEGORY_PATTERNS) {
        if (pattern.test(modelId)) {
            return category;
        }
    }

    return undefined;
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
            category: ("category" in m ? m.category : undefined) ?? inferCategory(m.id),
            pricing: (await dynamicPricingManager.getPricing(providerName, m.id)) || undefined,
        })),
    );

    return { models, config };
}
