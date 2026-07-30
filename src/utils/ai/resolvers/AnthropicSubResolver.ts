import type { DetectedProvider } from "@genesiscz/utils/ask/types";
import type { AIProvider } from "@genesiscz/utils/config/ai.types";
import { composeAuthFetch } from "../core/fetch";
import type { AccountResolver, ResolveAccountOptions } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

export class AnthropicSubResolver implements AccountResolver {
    readonly providerType: AIProvider = "anthropic-sub";

    async resolve(accountName: string, options?: ResolveAccountOptions): Promise<DetectedProvider> {
        const { resolveAccountToken } = await import("@genesiscz/utils/claude/subscription-auth");
        // `noRefresh` gates only this initial read. The per-request closures below
        // keep their refresh, because a diagnostic caller never issues a request.
        const { token, account } = await resolveAccountToken(accountName, { noRefresh: options?.noRefresh });

        const { createSubscriptionFetch, SUBSCRIPTION_BETAS, SUBSCRIPTION_SYSTEM_PREFIX } = await import(
            "@genesiscz/utils/claude/subscription-billing"
        );

        // Resolve the token per REQUEST, not at detection time: a long-running
        // process otherwise keeps serving a token another process has rotated
        // away (revoked-but-unexpired → upstream 401). On 401, force-refresh
        // once (fresh disk read + OAuth refresh) and retry. That dance now lives
        // in `composeAuthFetch`; `createSubscriptionFetch` stays underneath it
        // because it also strips x-api-key and injects the billing system block.
        const freshTokenFetch = composeAuthFetch({
            getToken: async () => (await resolveAccountToken(accountName)).token,
            refresh: async () => (await resolveAccountToken(accountName, { forceRefresh: true })).token,
            fetch: createSubscriptionFetch(),
        });

        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const provider = createAnthropic({
            apiKey: "oauth-placeholder",
            headers: {
                "anthropic-beta": SUBSCRIPTION_BETAS,
            },
            fetch: freshTokenFetch,
        });

        const { models, config: providerConfig } = await resolveModelsWithPricing("anthropic");

        return {
            name: "anthropic",
            type: "anthropic-sub",
            key: `${token.slice(0, 20)}...`,
            provider,
            models,
            config: providerConfig,
            systemPromptPrefix: SUBSCRIPTION_SYSTEM_PREFIX,
            subscription: true,
            account: { name: account.name, label: account.label },
        };
    }
}
