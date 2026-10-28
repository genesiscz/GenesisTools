import { listAnthropicSubProxyModels } from "@app/ai-proxy/lib/model-meta";
import { AnthropicSubscriptionProvider } from "@app/ai-proxy/lib/providers/anthropic-subscription";
import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { resolveAnthropicSubModel } from "@genesiscz/utils/ai/anthropic/models";

export const anthropicSubscriptionDefinition: ProviderDefinition = {
    title: "Claude subscription",
    defaultSlug: "claude-sub",
    agent: "claude",
    plugin: "anthropic-sub",
    billing: {
        plane: "subscription",
        nativeSource: () => "OAuth (anthropic subscription)",
    },
    login: {
        name: (account) => account.anthropicSub?.accountName,
        bind: (account, login) => ({ ...account, anthropicSub: { ...account.anthropicSub, accountName: login } }),
    },
    failover: null,
    models: {
        list: (account, options) => listAnthropicSubProxyModels(account, options),
        cacheFiles: () => [],
        // "haiku", "sonnet", "opus" and "fable" are served as aliases, and the ledger's rate table is exact-id: booking
        // the alias booked $0 (79 of 448 August requests).
        bookedId: (upstreamId) => resolveAnthropicSubModel(upstreamId),
        servesCatalogIds: false,
        emptyHint: null,
        catalogEntry: null,
    },
    usage: { snapshot: null },
    upstreamEndpoints: null,
    create: (account) => AnthropicSubscriptionProvider.create(account),
    // The short alias, not a dated id: the list always advertises `sonnet`, which follows the current model.
    suggestedModel: (account) => `${account.name}/${account.providerSlug}/sonnet`,
    introspect: async () => [],
};
