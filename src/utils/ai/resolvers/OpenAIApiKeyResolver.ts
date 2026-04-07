import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider } from "@ask/types";
import type { AccountResolver } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

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
        const { models, config: providerConfig } = await resolveModelsWithPricing("openai");

        return {
            name: "openai",
            type: "openai",
            key: `${entry.tokens.apiKey.slice(0, 12)}...`,
            provider,
            models,
            config: providerConfig,
            account: { name: entry.name, label: entry.label },
        };
    }
}
