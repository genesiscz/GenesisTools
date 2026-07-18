import { getProviderConfigs, KNOWN_MODELS } from "@genesiscz/utils/ask/providers/providers";
import type { ModelInfo, PricingInfo, ProviderConfig } from "@genesiscz/utils/ask/types";
import { logger } from "@genesiscz/utils/logger";

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
    const config = getProviderConfigs().find((c) => c.name === providerName);

    if (!config) {
        throw new Error(`${providerName} provider config missing from PROVIDER_CONFIGS`);
    }

    const knownModels = KNOWN_MODELS[providerName as keyof typeof KNOWN_MODELS];

    if (!knownModels) {
        return { models: [], config };
    }

    const getPricing = await loadPricingLookup();
    const models: ModelInfo[] = await Promise.all(
        knownModels.map(async (m) => ({
            ...m,
            provider: providerName,
            category: ("category" in m ? m.category : undefined) ?? inferCategory(m.id),
            pricing: (await getPricing(providerName, m.id)) || undefined,
        }))
    );

    return { models, config };
}

type PricingLookup = (provider: string, modelId: string) => Promise<PricingInfo | null | undefined>;

/**
 * Pricing enrichment lives in the ask tool (DynamicPricing drags the ask UI
 * stack) — inside @genesiscz/tools this resolves, but a standalone
 * @genesiscz/utils install has no @ask/* tree, so degrade to pricing-less
 * models instead of throwing.
 */
async function loadPricingLookup(): Promise<PricingLookup> {
    try {
        const { dynamicPricingManager } = await import("@ask/providers/DynamicPricing");
        return (provider, modelId) => dynamicPricingManager.getPricing(provider, modelId);
    } catch (error) {
        logger.debug(
            { err: error },
            "DynamicPricing unavailable (standalone @genesiscz/utils install?) — models resolve without pricing"
        );
        return async () => undefined;
    }
}
