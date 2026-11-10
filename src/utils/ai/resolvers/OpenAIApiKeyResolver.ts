import type { DetectedProvider } from "@genesiscz/utils/ask/types";
import type { AIProvider } from "@genesiscz/utils/config/ai.types";
import type { AccountResolver } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

export class OpenAIApiKeyResolver implements AccountResolver {
    readonly providerType: AIProvider = "openai";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { AiConfigStore } = await import("../config/AiConfigStore");
        const { resolveSecret } = await import("@genesiscz/utils/security");
        const entry = (await AiConfigStore.load()).account(accountName);
        // Resolved here, where the key is spent on the provider client.
        const apiKey = await resolveSecret(entry?.credentials.apiKey);

        if (!entry || !apiKey) {
            throw new Error(`No API key found for OpenAI account "${accountName}".`);
        }

        const { createOpenAI } = await import("@ai-sdk/openai");
        const provider = createOpenAI({ apiKey });
        const { models, config: providerConfig } = await resolveModelsWithPricing("openai");

        return {
            name: "openai",
            type: "openai",
            key: `${apiKey.slice(0, 12)}...`,
            provider,
            models,
            config: providerConfig,
            subscription: false,
            account: { name: entry.name, label: entry.label },
        };
    }
}
