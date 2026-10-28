import { listOpenRouterProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { OpenRouterApiKeyProvider } from "@app/ai-proxy/lib/providers/openrouter-api-key";

export const openRouterApiKeyDefinition: ProviderDefinition = {
    title: "OpenRouter",
    defaultSlug: "openrouter",
    agent: "other",
    plugin: "openrouter",
    billing: { plane: "api-key", envName: () => "OPENROUTER_API_KEY" },
    login: null,
    failover: null,
    models: {
        list: (account) => listOpenRouterProxyModels(account),
        cacheFiles: () => [],
        bookedId: (upstreamId) => upstreamId,
        // OpenRouter ids carry a slash (`anthropic/claude-sonnet-5`), so a slashed id its catalog lists is its own.
        servesCatalogIds: true,
        emptyHint: null,
        catalogEntry: null,
        facts: null,
    },
    usage: { snapshot: null },
    upstreamEndpoints: null,
    create: (account) => OpenRouterApiKeyProvider.create(account),
    // Three segments plus the slash inside the OpenRouter id: the fully qualified form `resolve-model.ts` parses
    // without ambiguity.
    suggestedModel: (account) => `${account.name}/${account.providerSlug}/anthropic/claude-sonnet-5.5`,
    introspect: async () => [],
};
