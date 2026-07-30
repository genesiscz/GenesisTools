import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { AnthropicSubResolver } from "../../resolvers/AnthropicSubResolver";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * Claude Max/Pro subscription.
 *
 * Wraps the existing resolver rather than reimplementing it: its per-request
 * token resolution and 401 force-refresh dance is load-bearing (a long-running
 * process otherwise serves a token another process already rotated away), and
 * rewriting that during a storage migration would be two risky changes at once.
 */
const resolver = new AnthropicSubResolver();

export const anthropicSubPlugin: ProviderPlugin = {
    id: "anthropic-sub",
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // Tokens live on the account, but the resolver reads them itself through
        // subscription-auth so refreshes stay atomic. Nothing is required here.
        fields: ["accessToken", "refreshToken"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const detected = await resolver.resolve(ctx.account.name);

        return {
            accountId: ctx.account.id,
            providerId: "anthropic-sub",
            billed: false,
            systemPromptPrefix: detected.systemPromptPrefix,
            language: (modelId: string) => getLanguageModel(detected.provider, modelId, "anthropic-sub"),
        };
    },

    async health(ctx: BindContext) {
        try {
            await resolver.resolve(ctx.account.name);
            return { ok: true, detail: "subscription token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },
};
