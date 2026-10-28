import { codexModelOverrides, listedCodexModels, setCodexModelOverrides } from "@app/ai-proxy/lib/codex-catalog";
import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { OpenAiSubscriptionProvider } from "@app/ai-proxy/lib/providers/openai-subscription";
import { listOpenAiSubProxyModels } from "@app/ai-proxy/lib/providers/openai-subscription.models";
import { CODEX_AUTH_PATH } from "@genesiscz/utils/ai/openai/codex-auth";

export const openAiSubscriptionDefinition: ProviderDefinition = {
    title: "ChatGPT/Codex subscription",
    defaultSlug: "codex",
    agent: "codex",
    plugin: "openai-sub",
    billing: {
        plane: "subscription",
        nativeSource: () => "OAuth (codex auth.json)",
    },
    login: {
        name: (account) => account.openaiSub?.accountName,
        bind: (account, login) => ({ ...account, openaiSub: { ...account.openaiSub, accountName: login } }),
    },
    failover: {
        accounts: (account) => account.openaiSub?.failoverAccountNames ?? [],
    },
    models: {
        list: (account, options) => listOpenAiSubProxyModels(account, options),
        // A legacy account reads the Codex CLI's own auth file, and a new login there can change the plan's list.
        cacheFiles: (account) => [account.openaiSub?.codexAuthPath ?? CODEX_AUTH_PATH],
        bookedId: (upstreamId) => upstreamId,
        servesCatalogIds: false,
        emptyHint: null,
        catalogEntry: null,
        facts: {
            label: "Codex",
            configure: (config) => setCodexModelOverrides(codexModelOverrides(config)),
            listed: () => listedCodexModels(),
        },
    },
    usage: { snapshot: null },
    routes: { chatViaResponses: true, reshapesChat: false, recoversCompaction: true },
    upstreamEndpoints: null,
    create: (account) => OpenAiSubscriptionProvider.create(account),
    suggestedModel: (account) => `${account.name}/${account.providerSlug}/gpt-6.1-sol`,
    introspect: async () => [],
};
