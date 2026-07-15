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

        // Resolve the token per REQUEST, not at detection time: a long-running
        // process otherwise keeps serving a token another process has rotated
        // away (revoked-but-unexpired → upstream 401). On 401, force-refresh
        // once (fresh disk read + OAuth refresh) and retry.
        const subscriptionFetch = createSubscriptionFetch();
        const freshTokenFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const call = (bearer: string): Promise<Response> => {
                const headers = new Headers(init?.headers);
                headers.set("Authorization", `Bearer ${bearer}`);
                return subscriptionFetch(input, { ...init, headers });
            };

            const { token: current } = await resolveAccountToken(accountName);
            const response = await call(current);

            if (response.status !== 401) {
                return response;
            }

            const { token: refreshed } = await resolveAccountToken(accountName, { forceRefresh: true });
            return call(refreshed);
        };

        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const provider = createAnthropic({
            apiKey: "oauth-placeholder",
            headers: {
                "anthropic-beta": SUBSCRIPTION_BETAS,
            },
            fetch: freshTokenFetch as typeof fetch,
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
