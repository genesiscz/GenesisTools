import type { DetectedProvider } from "@genesiscz/utils/ask/types";
import type { AIProvider } from "@genesiscz/utils/config/ai.types";
import { composeAuthFetch } from "../core/fetch";
import type { AccountResolver, ResolveAccountOptions } from "./index";
import { resolveModelsWithPricing } from "./resolve-models";

export class AnthropicSubResolver implements AccountResolver {
    readonly providerType: AIProvider = "anthropic-sub";

    async resolve(accountName: string, options?: ResolveAccountOptions): Promise<DetectedProvider> {
        const { recoverInferenceToken, resolveInferenceToken } = await import(
            "@genesiscz/utils/claude/subscription-auth"
        );
        // `noRefresh` gates only this initial read. The per-request closures below
        // keep their refresh, because a diagnostic caller never issues a request.
        // The long-lived token wins when the account has one, so binding an account
        // whose OAuth pair expired no longer spends (or fails on) its refresh token.
        const initial = await resolveInferenceToken(accountName, { noRefresh: options?.noRefresh });

        const { createSubscriptionFetch, SUBSCRIPTION_BETAS, SUBSCRIPTION_SYSTEM_PREFIX } = await import(
            "@genesiscz/utils/claude/subscription-billing"
        );

        // Resolve the token per REQUEST, not at detection time: a long-running
        // process otherwise keeps serving a token another process has rotated
        // away (revoked-but-unexpired → upstream 401). On 401, recover once: a
        // rejected long-lived token falls back to the OAuth pair, a rejected
        // access token is force-refreshed. `createSubscriptionFetch` stays
        // underneath because it also strips x-api-key and injects the billing block.
        // Each request recovers from the token IT sent: a shared "current" let one request's 401
        // recover from a token another request had just resolved.
        type Resolved = Awaited<ReturnType<typeof resolveInferenceToken>>;
        const sent = new Map<string, Resolved>([[initial.token, initial]]);
        const remember = (resolved: Resolved): string => {
            sent.delete(resolved.token);
            sent.set(resolved.token, resolved);

            while (sent.size > 8) {
                const oldest = sent.keys().next().value;

                if (oldest === undefined) {
                    break;
                }

                sent.delete(oldest);
            }

            return resolved.token;
        };
        const freshTokenFetch = composeAuthFetch({
            getToken: async () => remember(await resolveInferenceToken(accountName)),
            refresh: async (rejected) =>
                remember(await recoverInferenceToken(accountName, sent.get(rejected) ?? initial)),
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
            key: `${initial.token.slice(0, 20)}...`,
            provider,
            models,
            config: providerConfig,
            systemPromptPrefix: SUBSCRIPTION_SYSTEM_PREFIX,
            subscription: true,
            account: { name: initial.accountName, label: initial.label },
        };
    }
}
