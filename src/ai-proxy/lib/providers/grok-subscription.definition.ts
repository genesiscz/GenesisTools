import { resolveGrokAuthPath } from "@app/ai-proxy/lib/account-config";
import { listGrokProxyModels } from "@app/ai-proxy/lib/model-meta";
import type { ProviderDefinition } from "@app/ai-proxy/lib/providers/definition";
import { GrokSubscriptionProvider } from "@app/ai-proxy/lib/providers/grok-subscription";
import {
    buildGrokModelCatalog,
    formatBillingSummary,
    GROK_CLI_CHAT_PROXY_BASE_URL,
    GROK_UPSTREAM_ENDPOINTS,
    GrokSubscriptionClient,
} from "@genesiscz/utils/ai/grok";
import { logger } from "@genesiscz/utils/logger";

/** The cli-chat-proxy a Grok account calls when its config names no `baseUrl`, as `introspect` and the catalog file print it. */
const GROK_PRINTED_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

export const grokSubscriptionDefinition: ProviderDefinition = {
    title: "Grok",
    defaultSlug: "grok",
    agent: "grok",
    plugin: "grok-sub",
    billing: {
        plane: "subscription",
        nativeSource: (account) => `OAuth ${resolveGrokAuthPath(account)}`,
    },
    login: {
        name: (account) => account.grok?.accountName,
        bind: (account, login) => ({ ...account, grok: { ...account.grok, accountName: login } }),
    },
    failover: null,
    models: {
        list: async (account) => listGrokProxyModels(account, account.baseUrl ?? GROK_CLI_CHAT_PROXY_BASE_URL),
        // The picker cache the list reads lives beside the auth file, and a new login brings a new cache.
        cacheFiles: (account) => [resolveGrokAuthPath(account)],
        bookedId: (upstreamId) => upstreamId,
        servesCatalogIds: false,
        emptyHint: null,
        catalogEntry: async (account, { probe }) => {
            const authPath = resolveGrokAuthPath(account);
            const client = await GrokSubscriptionClient.fromAuthFile(authPath);

            if (!client) {
                return { skipped: `no auth at ${authPath}` };
            }

            const catalog = await buildGrokModelCatalog(client, { probe });
            // Never persist dead ids: the proxy list and Cursor's picker only see working models.
            const available = catalog.filter((model) => model.probeStatus !== "fail");

            return {
                entry: {
                    accountName: account.name,
                    provider: account.provider,
                    baseUrl: account.baseUrl ?? GROK_PRINTED_BASE_URL,
                    pickerModels: available.filter((model) => model.source === "picker"),
                    probedModels: available.filter((model) => model.source !== "picker"),
                    upstreamEndpoints: GROK_UPSTREAM_ENDPOINTS,
                },
                dropped: catalog.length - available.length,
            };
        },
        facts: null,
    },
    usage: {
        snapshot: (usage) => {
            const grok = usage.details && "grok" in usage.details ? usage.details.grok : undefined;

            if (!grok?.billing) {
                return null;
            }

            return { fetchedAt: new Date().toISOString(), tier: usage.tier, summary: usage.summary, details: { grok } };
        },
    },
    // The chat stream already carries the reasoning Cursor renders. A re-encode through /responses lost the role
    // coalescing and broke the thinking UI.
    routes: { chatViaResponses: false, reshapesChat: true, recoversCompaction: false },
    upstreamEndpoints: GROK_UPSTREAM_ENDPOINTS,
    create: (account, options) => GrokSubscriptionProvider.create({ account, options }),
    suggestedModel: (account) => `${account.name}/grok/grok-composer-2.5-fast`,
    introspect: async (account) => {
        const authPath = resolveGrokAuthPath(account);
        const lines = [`Upstream:     ${account.baseUrl ?? GROK_PRINTED_BASE_URL}`, `Auth:         ${authPath}`];

        try {
            const client = await GrokSubscriptionClient.fromAuthFile(authPath);

            if (client) {
                const [settings, billing] = await Promise.all([client.getSettings(), client.getBilling()]);
                lines.push(`Tier:         ${settings.subscription_tier_display ?? "unknown"}`);
                lines.push(`Usage:        ${formatBillingSummary(billing)}`);
            }
        } catch (err) {
            logger.warn({ err, account: account.name, authPath }, "ai-proxy introspect: grok auth probe failed");
            lines.push("Auth status:  unavailable");
        }

        return lines;
    },
};
