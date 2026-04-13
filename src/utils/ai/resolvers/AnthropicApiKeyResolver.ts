import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider } from "@ask/types";
import type { AccountResolver } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

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
        const { models, config: providerConfig } = await resolveModelsWithPricing("anthropic");

        return {
            name: "anthropic",
            type: "anthropic",
            key: `${entry.tokens.apiKey.slice(0, 12)}...`,
            provider,
            models,
            config: providerConfig,
            account: { name: entry.name, label: entry.label },
        };
    }
}
