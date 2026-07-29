import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { WEB_SERVICES } from "@genesiscz/utils/ui/dashboards";
import { resolveCredential } from "../credentials";
import type { BindContext, ProviderBinding, ProviderPlugin } from "../plugin-types";

/**
 * The local ai-proxy as a provider.
 *
 * Calls through it bill whichever subscription account backs the requested model
 * id, so the credential here is only the proxy's own client key — never a
 * per-token API key. This generalizes what eve does by hand
 * (`apps/eve/agent/model.ts`), so any surface can target the proxy the same way.
 */
const DEFAULT_BASE_URL = `http://127.0.0.1:${WEB_SERVICES["ai-proxy"].port}/v1`;

export const aiProxyPlugin: ProviderPlugin = {
    id: "ai-proxy",
    kind: "gateway",
    capabilities: new Set(["chat", "summarize", "translate"]),
    credential: {
        fields: ["apiKey"],
        // The proxy key is per-machine and belongs in the vault; there is no
        // conventional variable for it, so nothing is declared here.
        envKeys: [],
        required: ["apiKey"],
    },

    async bind(ctx: BindContext): Promise<ProviderBinding> {
        const { apiKey } = await resolveCredential(ctx.account, this.credential);

        if (!apiKey) {
            throw new Error("ai-proxy client key missing");
        }

        const proxy = createOpenAICompatible({
            name: "ai-proxy",
            baseURL: ctx.account.endpoint ?? DEFAULT_BASE_URL,
            apiKey,
        });

        return {
            accountId: ctx.account.id,
            providerId: "ai-proxy",
            // The proxy books cost against the backing account's ledger, so a
            // call through it is not separately metered here.
            billed: false,
            language: (modelId: string) => proxy(modelId),
        };
    },

    async health(ctx: BindContext) {
        const baseURL = ctx.account.endpoint ?? DEFAULT_BASE_URL;

        try {
            const { apiKey } = await resolveCredential(ctx.account, this.credential);
            const response = await fetch(`${baseURL}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
            });

            return {
                ok: response.ok,
                detail: response.ok ? `${baseURL} reachable` : `${baseURL} returned ${response.status}`,
            };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
    },
};
