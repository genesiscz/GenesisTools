import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider, ModelInfo } from "@ask/types";
import type { AccountResolver } from "./index";

export class OpenAIApiKeyResolver implements AccountResolver {
    readonly providerType: AIProvider = "openai";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { AIConfig } = await import("../AIConfig");
        const config = await AIConfig.load();
        const entry = config.getAccount(accountName);

        if (!entry?.tokens.apiKey) {
            throw new Error(`No API key found for OpenAI account "${accountName}".`);
        }

        const { createOpenAI } = await import("@ai-sdk/openai");
        const provider = createOpenAI({ apiKey: entry.tokens.apiKey });

        const { getProviderConfigs, KNOWN_MODELS } = await import("@ask/providers/providers");
        const openaiConfig = getProviderConfigs().find((c) => c.name === "openai");

        if (!openaiConfig) {
            throw new Error("openai provider config missing from PROVIDER_CONFIGS");
        }

        const { dynamicPricingManager } = await import("@ask/providers/DynamicPricing");
        const models: ModelInfo[] = await Promise.all(
            KNOWN_MODELS.openai.map(async (m) => ({
                ...m,
                provider: "openai" as const,
                pricing: (await dynamicPricingManager.getPricing("openai", m.id)) || undefined,
            }))
        );

        return {
            name: "openai",
            type: "openai",
            key: `${entry.tokens.apiKey.slice(0, 12)}...`,
            provider,
            models,
            config: openaiConfig,
            account: { name: entry.name, label: entry.label },
        };
    }
}
