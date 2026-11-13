import { anthropicSubscriptionDefinition } from "@app/ai-proxy/lib/providers/anthropic-subscription.definition";
import type {
    ModelOverridesConfig,
    ProviderDefinition,
    ProviderLogin,
    ProxyPluginId,
} from "@app/ai-proxy/lib/providers/definition";
import { githubCopilotSubscriptionDefinition } from "@app/ai-proxy/lib/providers/github-copilot-subscription.definition";
import { grokSubscriptionDefinition } from "@app/ai-proxy/lib/providers/grok-subscription.definition";
import { openAiApiKeyDefinition } from "@app/ai-proxy/lib/providers/openai-api-key.definition";
import { openAiSubscriptionDefinition } from "@app/ai-proxy/lib/providers/openai-subscription.definition";
import { openRouterApiKeyDefinition } from "@app/ai-proxy/lib/providers/openrouter-api-key.definition";
import { xaiApiKeyDefinition } from "@app/ai-proxy/lib/providers/xai-api-key.definition";
import type { SessionAgent } from "@app/ai-proxy/lib/sessions/records";
import type { AiProxyProviderType } from "@app/ai-proxy/lib/types";

/**
 * One entry per provider type. The key type is the union, so a provider with no entry, or an entry for no provider,
 * is a compile error: a new provider is its definition file plus one line here.
 *
 * This module is a leaf of static facts: a definition loads its provider class only when `create` runs, and the live
 * providers (`buildProviderMap`, `acquireProvider`) are in `pool.ts`. `scripts/ci/proxy-provider-ratchet.ts` checks
 * that importing this table loads no provider class.
 *
 * The order is the order of `providerTypes()`: subscriptions first, so an error that lists the plugins the proxy
 * serves names them as it always did (`grok-sub, anthropic-sub, openai-sub, xai, openai, openrouter`).
 */
export const PROVIDER_DEFINITIONS: Readonly<Record<AiProxyProviderType, ProviderDefinition>> = {
    "grok-subscription": grokSubscriptionDefinition,
    "github-copilot-subscription": githubCopilotSubscriptionDefinition,
    "anthropic-subscription": anthropicSubscriptionDefinition,
    "openai-subscription": openAiSubscriptionDefinition,
    "xai-api-key": xaiApiKeyDefinition,
    openai: openAiApiKeyDefinition,
    openrouter: openRouterApiKeyDefinition,
};

/** Narrows a provider name from the JSON config, which no type checks, to one this build implements. */
export function isProviderImplemented(provider: string): provider is AiProxyProviderType {
    return Object.hasOwn(PROVIDER_DEFINITIONS, provider);
}

/** The definition of a provider, or undefined for a name this build does not know (a hand-edited config). */
export function providerDefinition(provider: string): ProviderDefinition | undefined {
    return isProviderImplemented(provider) ? PROVIDER_DEFINITIONS[provider] : undefined;
}

export function providerTypes(): AiProxyProviderType[] {
    return Object.keys(PROVIDER_DEFINITIONS).filter(isProviderImplemented);
}

/** A seat that bills a personal subscription: owner-only, because serving it to anybody else is resale. */
export function isSubscriptionProvider(provider: string): boolean {
    return providerDefinition(provider)?.billing.plane === "subscription";
}

/** Metered per token through an API key, which the account stores or reads from an env var. */
export function isApiKeyProvider(provider: string): boolean {
    return providerDefinition(provider)?.billing.plane === "api-key";
}

/** The proxy provider that serves the AI-config accounts of a `ProviderPlugin` (`openai-sub`, `xai`, ...). */
export function providerForPlugin(
    plugin: string
): { type: AiProxyProviderType; definition: ProviderDefinition } | undefined {
    const type = providerTypes().find((candidate) => PROVIDER_DEFINITIONS[candidate].plugin === plugin);

    return type ? { type, definition: PROVIDER_DEFINITIONS[type] } : undefined;
}

/** Every plugin whose AI-config accounts the proxy serves, in table order. */
export function servedPlugins(): ProxyPluginId[] {
    return providerTypes().flatMap((type) => PROVIDER_DEFINITIONS[type].plugin ?? []);
}

/** Hands this request's proxy config to each provider's model facts, so an edited model override applies at once. */
export function configureModelFacts(config: ModelOverridesConfig): void {
    for (const type of providerTypes()) {
        PROVIDER_DEFINITIONS[type].models.facts?.configure(config);
    }
}

/**
 * The provider a session agent's logins run on: the one that serves the agent and names an AI-config login
 * (`openai-subscription` for codex). An agent always has one; the table not giving it one is a programming error.
 */
export function loginProviderFor(agent: SessionAgent): {
    type: AiProxyProviderType;
    definition: ProviderDefinition;
    login: ProviderLogin;
    plugin: ProxyPluginId;
} {
    for (const type of providerTypes()) {
        const definition = PROVIDER_DEFINITIONS[type];

        if (definition.agent === agent && definition.login && definition.plugin) {
            return { type, definition, login: definition.login, plugin: definition.plugin };
        }
    }

    throw new Error(`ai-proxy: no provider serves the ${agent} agent's logins`);
}
