import type { AIProvider } from "@app/utils/config/ai.types";
import type { DetectedProvider } from "@ask/types";
import type { AccountResolver } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

export class AnthropicSubResolver implements AccountResolver {
    readonly providerType: AIProvider = "anthropic-sub";

    async resolve(accountName: string): Promise<DetectedProvider> {
        const { resolveAccountToken } = await import("@app/utils/claude/subscription-auth");
        const { token, account } = await resolveAccountToken(accountName);

        const { createSubscriptionFetch, SUBSCRIPTION_BETAS, SUBSCRIPTION_SYSTEM_PREFIX } = await import(
            "@app/utils/claude/subscription-billing"
        );

        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const provider = createAnthropic({
            apiKey: "oauth-placeholder",
            headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-beta": SUBSCRIPTION_BETAS,
            },
            fetch: createSubscriptionFetch(),
        });

        const { models, config: providerConfig } = await resolveModelsWithPricing("anthropic");

        return {
            name: "anthropic",
            type: "anthropic",
            key: `${token.slice(0, 20)}...`,
            provider,
            models,
            config: providerConfig,
            systemPromptPrefix: SUBSCRIPTION_SYSTEM_PREFIX,
            account: { name: account.name, label: account.label },
        };
    }
}
