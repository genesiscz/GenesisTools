import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { OpenAISubResolver } from "../../../resolvers/OpenAISubResolver";
import type { AccountFeatures } from "../../account-features";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../../plugin-types";

/**
 * Codex (ChatGPT plan) subscription over the WHAM endpoint.
 *
 * Wraps the existing resolver: its per-request token resolution keeps a
 * long-running process following the Codex CLI's refreshes, which is exactly the
 * behaviour that must not change while storage moves under it.
 */
const resolver = new OpenAISubResolver();

/** The two windows the Codex app-server reports: a 5h `primary` and a weekly `secondary`. */
const presentation: AccountFeatures["presentation"] = {
    displayName: "Codex",
    alias: "codex",
    limitOrder: ["primary", "secondary"],
    prominentLimits: ["primary", "secondary"],
};

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
        const detected = await resolver.resolve(ctx.account.name, { noRefresh: ctx.probe });

        return {
            accountId: ctx.account.id,
            providerId: "openai-sub",
            billed: false,
            language: (modelId: string) => getLanguageModel(detected.provider, modelId, "openai-sub"),
        };
    },

    /**
     * Read-side only, per CLAUDE.md "A diagnostic must never mutate". `health` is
     * always a probe; `bind` honours `ctx.probe` so testing an account observes
     * it instead of changing it.
     */
    async health(ctx: BindContext) {
        try {
            await resolver.resolve(ctx.account.name, { noRefresh: true });
            return { ok: true, detail: "codex subscription token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },

    accounts: {
        presentation,
        logoutTargets: ["oauth", "authFile"],
    },
};
