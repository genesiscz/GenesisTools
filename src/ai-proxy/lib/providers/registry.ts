import { homedir } from "node:os";
import {
    accountBindingFingerprint,
    accountConfigFingerprint,
    describeAccountCredential,
} from "@app/ai-proxy/lib/account-config";
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
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { xaiApiKeyDefinition } from "@app/ai-proxy/lib/providers/xai-api-key.definition";
import type { SessionAgent } from "@app/ai-proxy/lib/sessions/records";
import type { AiProxyAccountConfig, AiProxyProviderType } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export function providerKey(account: { name: string; providerSlug: string }): string {
    return `${account.name}/${account.providerSlug}`;
}

/** A route that names its own provider (`providerKeySuffix`, a session's copy of an account) keeps it apart. */
export function routeProviderKey(route: {
    accountName: string;
    providerSlug: string;
    providerKeySuffix?: string;
}): string {
    return `${providerKey({ name: route.accountName, providerSlug: route.providerSlug })}${route.providerKeySuffix ?? ""}`;
}

/**
 * One entry per provider type. The key type is the union, so a provider with no entry, or an entry for no provider,
 * is a compile error: a new provider is its definition file plus one line here.
 *
 * Each entry is a getter, read when a caller asks and never while this module loads. The provider files reach modules
 * that import this one back (the Copilot provider reaches `resolve-model.ts` through its translator), so a table
 * that copied the definitions at load could read one before its file had run, depending on which module loaded first.
 *
 * The order is the order of `providerTypes()`: subscriptions first, so an error that lists the plugins the proxy
 * serves names them as it always did (`grok-sub, anthropic-sub, openai-sub, xai, openai, openrouter`).
 */
export const PROVIDER_DEFINITIONS: Readonly<Record<AiProxyProviderType, ProviderDefinition>> = {
    get "grok-subscription"() {
        return grokSubscriptionDefinition;
    },
    get "github-copilot-subscription"() {
        return githubCopilotSubscriptionDefinition;
    },
    get "anthropic-subscription"() {
        return anthropicSubscriptionDefinition;
    },
    get "openai-subscription"() {
        return openAiSubscriptionDefinition;
    },
    get "xai-api-key"() {
        return xaiApiKeyDefinition;
    },
    get openai() {
        return openAiApiKeyDefinition;
    },
    get openrouter() {
        return openRouterApiKeyDefinition;
    },
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

export async function buildProviderMap(
    accounts: Iterable<AiProxyAccountConfig>,
    filter?: (account: AiProxyAccountConfig) => boolean
): Promise<Map<string, ProxyProvider>> {
    const providers = new Map<string, ProxyProvider>();

    for (const account of accounts) {
        if (!account.enabled) {
            continue;
        }

        if (filter && !filter(account)) {
            continue;
        }

        const provider = await tryCreateProvider(account);

        if (provider) {
            providers.set(providerKey(account), provider);
        }
    }

    return providers;
}

function implemented(account: AiProxyAccountConfig): ProviderDefinition {
    const definition = providerDefinition(account.provider);

    if (!definition) {
        throw new Error(`Provider not implemented yet: ${account.provider}`);
    }

    return definition;
}

export async function createProvider(account: AiProxyAccountConfig): Promise<ProxyProvider> {
    return implemented(account).create(account);
}

/** For a diagnostic (`accounts test`): the provider must not spend a single-use grant while it is inspected. */
export async function createProviderForInspection(account: AiProxyAccountConfig): Promise<ProxyProvider> {
    return implemented(account).create(account, { probe: true });
}

/**
 * The last binding fingerprint each provider was built from.
 *
 * A provider only carries its OWN config hash (`accountFingerprint`), so a
 * credential edited in `tools ai config` or a token rotated into the vault
 * changed nothing it could observe. Tracking the extended hash here rebuilds the
 * provider on those edits without every provider class having to learn about the
 * AI config.
 */
const bindingFingerprints = new Map<string, string>();

export function _resetBindingFingerprintsForTest(): void {
    bindingFingerprints.clear();
}

/**
 * Fetch the cached provider for a resolved route, recreating it when the
 * account config changed (fingerprint mismatch) or it was never built. Returns
 * null when the provider cannot be created.
 */
export async function acquireProvider(
    providers: Map<string, ProxyProvider>,
    route: { accountName: string; providerSlug: string; providerKeySuffix?: string; account: AiProxyAccountConfig }
): Promise<ProxyProvider | null> {
    const key = routeProviderKey(route);
    const fingerprint = accountConfigFingerprint(route.account);
    const binding = await accountBindingFingerprint(route.account);
    let provider = providers.get(key);

    if (provider && bindingFingerprints.get(key) !== binding) {
        logger.info(
            { account: route.accountName, provider: route.account.provider },
            "ai-proxy: referenced credential changed — rebuilding the account's provider"
        );
        providers.delete(key);
        provider = undefined;
    }

    if (provider && provider.accountFingerprint !== fingerprint) {
        const refreshed = await tryCreateProvider(route.account);
        if (refreshed) {
            providers.set(key, refreshed);
            provider = refreshed;
        } else {
            providers.delete(key);
            provider = undefined;
        }
    }

    if (!provider) {
        const created = await tryCreateProvider(route.account);
        if (created) {
            providers.set(key, created);
            provider = created;
        }
    }

    if (provider) {
        bindingFingerprints.set(key, binding);
    } else {
        bindingFingerprints.delete(key);
    }

    return provider ?? null;
}

/**
 * Why each provider failed to construct, keyed like `providerKey()`. Without it
 * a route to a broken account could only answer "Provider not loaded: <key>",
 * which says nothing about the missing credential that actually caused it.
 */
const providerFailures = new Map<string, string>();

export function lastProviderFailure(key: string): string | undefined {
    return providerFailures.get(key);
}

export async function tryCreateProvider(account: AiProxyAccountConfig): Promise<ProxyProvider | null> {
    const key = providerKey(account);

    if (!account.enabled || !isProviderImplemented(account.provider)) {
        if (account.enabled && !isProviderImplemented(account.provider)) {
            logger.warn(
                { account: account.name, provider: account.provider },
                "ai-proxy: skipping unimplemented provider at runtime"
            );
            providerFailures.set(key, `provider "${account.provider}" is not implemented`);
        }

        return null;
    }

    try {
        const provider = await createProvider(account);
        providerFailures.delete(key);
        const credential = describeAccountCredential(account);

        logger.info(
            {
                account: account.name,
                provider: account.provider,
                credentialSource: credential.source,
                billed: credential.billed,
            },
            credential.billed
                ? "ai-proxy: account ready on a BILLED api key — every call costs metered money"
                : "ai-proxy: account ready on a subscription login"
        );

        return provider;
    } catch (err) {
        // One unusable account (missing key env var, expired auth) must not take
        // down the whole proxy — routes to healthy accounts keep serving.
        const message = err instanceof Error ? err.message : String(err);
        providerFailures.set(key, message);
        logger.warn(
            { err, account: account.name, provider: account.provider, reason: message },
            "ai-proxy: account unavailable — skipping"
        );

        return null;
    }
}

/**
 * The api-key constructors say only which account and env var are missing, which
 * is exactly what the caller needs. The OAuth/file-based ones can name local
 * paths, so home directories are collapsed and the text is bounded before it
 * leaves the process — the full error is already in the server log.
 */
function publicFailureReason(reason: string | undefined): string | undefined {
    if (!reason) {
        return undefined;
    }

    const withoutHome = reason.replaceAll(homedir(), "~");

    return withoutHome.length > 300 ? `${withoutHome.slice(0, 300)}…` : withoutHome;
}

/**
 * 503 (not 500) for a route whose account never constructed: the proxy is fine,
 * that one account's credentials are not. The construction error is echoed so
 * the caller sees WHICH credential is missing.
 */
export function providerUnavailableResponse(route: {
    accountName: string;
    providerSlug: string;
    providerKeySuffix?: string;
}): Response {
    const key = routeProviderKey(route);
    const reason = publicFailureReason(lastProviderFailure(key));

    return new Response(
        SafeJSON.stringify({
            error: {
                message: reason ? `Provider not loaded: ${key} — ${reason}` : `Provider not loaded: ${key}`,
                type: "provider_unavailable",
                code: "provider_not_loaded",
            },
        }),
        {
            status: 503,
            headers: { "Content-Type": "application/json", "retry-after": "30" },
        }
    );
}
