import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider, ModelInfo } from "@ask/types";
import type { AccountResolver } from "./index";

export class AnthropicApiKeyResolver implements AccountResolver {
    readonly providerType: AIProvider = "anthropic";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { AIConfig } = await import("../AIConfig");
        const config = await AIConfig.load();
        const entry = config.getAccount(accountName);

        if (!entry?.tokens.apiKey) {
            throw new Error(`No API key found for account "${accountName}".`);
        }

        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const provider = createAnthropic({ apiKey: entry.tokens.apiKey });

        const { getProviderConfigs, KNOWN_MODELS } = await import("@ask/providers/providers");
        const anthropicConfig = getProviderConfigs().find((c) => c.name === "anthropic");

        if (!anthropicConfig) {
            throw new Error("anthropic provider config missing from PROVIDER_CONFIGS");
        }

        const { dynamicPricingManager } = await import("@ask/providers/DynamicPricing");
        const models: ModelInfo[] = await Promise.all(
            KNOWN_MODELS.anthropic.map(async (m) => ({
                ...m,
                provider: "anthropic" as const,
                pricing: (await dynamicPricingManager.getPricing("anthropic", m.id)) || undefined,
            }))
        );

        return {
            name: "anthropic",
            type: "anthropic",
            key: `${entry.tokens.apiKey.slice(0, 12)}...`,
            provider,
            models,
            config: anthropicConfig,
            account: { name: entry.name, label: entry.label },
        };
    }
}
