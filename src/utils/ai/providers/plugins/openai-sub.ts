import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { OpenAISubResolver } from "../../resolvers/OpenAISubResolver";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * Codex (ChatGPT plan) subscription over the WHAM endpoint.
 *
 * Wraps the existing resolver: its per-request token resolution keeps a
 * long-running process following the Codex CLI's refreshes, which is exactly the
 * behaviour that must not change while storage moves under it.
 */
const resolver = new OpenAISubResolver();

export const openAiSubPlugin: ProviderPlugin = {
    id: "openai-sub",
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        // The Codex CLI auth file is the source of truth; the resolver reads it
        // per request, so nothing here is required up front.
        fields: ["authFile", "accessToken", "refreshToken"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const detected = await resolver.resolve(ctx.account.name);

        return {
            accountId: ctx.account.id,
            providerId: "openai-sub",
            billed: false,
            language: (modelId: string) => getLanguageModel(detected.provider, modelId, "openai-sub"),
        };
    },

    async health(ctx: BindContext) {
        try {
            await resolver.resolve(ctx.account.name);
            return { ok: true, detail: "codex subscription token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },
};
