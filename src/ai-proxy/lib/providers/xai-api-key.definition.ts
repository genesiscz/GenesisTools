import { listXaiProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { XaiApiKeyProvider } from "@app/ai-proxy/lib/providers/xai-api-key";
import { env } from "@genesiscz/utils/env";

/** Alias-aware: an account relying on the legacy `X_AI_API_KEY` is told the variable that was actually read. */
export function xaiApiKeyEnvName(): string {
    return env.x.getApiEnvKey() ?? "XAI_API_KEY";
}

export const xaiApiKeyDefinition: ProviderDefinition = {
    title: "xAI API",
    defaultSlug: "xai",
    agent: "grok",
    plugin: "xai",
    billing: { plane: "api-key", envName: xaiApiKeyEnvName },
    login: null,
    failover: null,
    models: {
        list: (account) => listXaiProxyModels(account),
        cacheFiles: () => [],
        bookedId: (upstreamId) => upstreamId,
        servesCatalogIds: false,
        // The list comes from `GET /models` with the account's key, so an empty one points at the key.
        emptyHint: "no models (check API key / GET /models)",
        catalogEntry: null,
    },
    usage: { snapshot: null },
    upstreamEndpoints: null,
    create: (account) => XaiApiKeyProvider.create(account),
    suggestedModel: (account) => `${account.name}/${account.providerSlug}/grok-4.7`,
    introspect: async () => [],
};
