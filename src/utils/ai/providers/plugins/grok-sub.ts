import { getLanguageModel } from "@genesiscz/utils/ask/types/provider";
import { GrokSubResolver } from "../../resolvers/GrokSubResolver";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * SuperGrok subscription through the Grok CLI chat proxy.
 *
 * Wraps the existing resolver, which live-reads the CLI auth file per request
 * and sends the CLI identification headers the proxy 426s without.
 */
const resolver = new GrokSubResolver();

export const grokSubPlugin: ProviderPlugin = {
    id: "grok-sub",
    kind: "subscription",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        fields: ["authFile"],
        envKeys: [],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const detected = await resolver.resolve(ctx.account.name, { noRefresh: ctx.probe });

        return {
            accountId: ctx.account.id,
            providerId: "grok-sub",
            billed: false,
            language: (modelId: string) => getLanguageModel(detected.provider, modelId, "grok-sub"),
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
            return { ok: true, detail: "grok CLI token resolved" };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },
};
