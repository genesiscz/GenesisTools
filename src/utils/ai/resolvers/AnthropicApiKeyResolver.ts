import type { DetectedProvider } from "@genesiscz/utils/ask/types";
import type { AIProvider } from "@genesiscz/utils/config/ai.types";
import type { AccountResolver } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

export class AnthropicApiKeyResolver implements AccountResolver {
    readonly providerType: AIProvider = "anthropic";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { AiConfigStore } = await import("../config/AiConfigStore");
        const { resolveSecret } = await import("@genesiscz/utils/security");
        const entry = (await AiConfigStore.load()).account(accountName);
        // Resolved here, where the key is spent on the provider client.
        const apiKey = await resolveSecret(entry?.credentials.apiKey);

        if (!entry || !apiKey) {
            throw new Error(`No API key found for account "${accountName}".`);
        }

        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const provider = createAnthropic({ apiKey });
        const { models, config: providerConfig } = await resolveModelsWithPricing("anthropic");

        return {
            name: "anthropic",
            type: "anthropic",
            key: `${apiKey.slice(0, 12)}...`,
            provider,
            models,
            config: providerConfig,
            subscription: false,
            account: { name: entry.name, label: entry.label },
        };
    }
}
