import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { OpenAiApiKeyProvider } from "@app/ai-proxy/lib/providers/openai-api-key";
import { listOpenAiProxyModels } from "@app/ai-proxy/lib/providers/openai-api-key.models";

export const openAiApiKeyDefinition: ProviderDefinition = {
    title: "OpenAI API",
    defaultSlug: "openai",
    agent: "other",
    plugin: "openai",
    billing: { plane: "api-key", envName: () => "OPENAI_API_KEY" },
    login: null,
    failover: null,
    models: {
        list: (account) => listOpenAiProxyModels(account),
        cacheFiles: () => [],
        bookedId: (upstreamId) => upstreamId,
        servesCatalogIds: false,
        emptyHint: null,
        catalogEntry: null,
        facts: null,
    },
    usage: { snapshot: null },
    routes: { chatViaResponses: true, reshapesChat: false, recoversCompaction: false },
    upstreamEndpoints: null,
    create: (account) => OpenAiApiKeyProvider.create(account),
    suggestedModel: (account) => `${account.name}/${account.providerSlug}/gpt-6.1-sol`,
    introspect: async () => [],
};
