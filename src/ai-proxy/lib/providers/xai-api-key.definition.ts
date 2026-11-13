import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { listXaiProxyModels } from "@app/ai-proxy/lib/providers/xai-api-key.models";
import { xaiApiKeyEnvName } from "@app/ai-proxy/lib/providers/xai-api-key-auth";

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
        facts: null,
    },
    usage: { snapshot: null },
    routes: { chatViaResponses: true, reshapesChat: false, recoversCompaction: false },
    upstreamEndpoints: null,
    create: async (account) =>
        (await import("@app/ai-proxy/lib/providers/xai-api-key")).XaiApiKeyProvider.create(account),
    suggestedModel: (account) => `${account.name}/${account.providerSlug}/grok-4.7`,
    introspect: async () => [],
};
