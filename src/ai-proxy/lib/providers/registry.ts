import { homedir } from "node:os";
import { accountConfigFingerprint, describeAccountCredential } from "@app/ai-proxy/lib/account-config";
import { AnthropicSubscriptionProvider } from "@app/ai-proxy/lib/providers/anthropic-subscription";
import { GithubCopilotSubscriptionProvider } from "@app/ai-proxy/lib/providers/github-copilot-subscription";
import { GrokSubscriptionProvider } from "@app/ai-proxy/lib/providers/grok-subscription";
import { OpenAiApiKeyProvider } from "@app/ai-proxy/lib/providers/openai-api-key";
import { OpenAiSubscriptionProvider } from "@app/ai-proxy/lib/providers/openai-subscription";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import { XaiApiKeyProvider } from "@app/ai-proxy/lib/providers/xai-api-key";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export function providerKey(account: { name: string; providerSlug: string }): string {
    return `${account.name}/${account.providerSlug}`;
}

export function routeProviderKey(route: { accountName: string; providerSlug: string }): string {
    return providerKey({ name: route.accountName, providerSlug: route.providerSlug });
}

export function isProviderImplemented(provider: AiProxyAccountConfig["provider"]): boolean {
    return (
        provider === "grok-subscription" ||
        provider === "github-copilot-subscription" ||
        provider === "anthropic-subscription" ||
        provider === "openai-subscription" ||
        provider === "xai-api-key" ||
        provider === "openai"
    );
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

export async function createProvider(account: AiProxyAccountConfig): Promise<ProxyProvider> {
    if (account.provider === "grok-subscription") {
        return GrokSubscriptionProvider.create(account);
    }

    if (account.provider === "github-copilot-subscription") {
        return GithubCopilotSubscriptionProvider.create(account);
    }

    if (account.provider === "anthropic-subscription") {
        return AnthropicSubscriptionProvider.create(account);
    }

    if (account.provider === "openai-subscription") {
        return OpenAiSubscriptionProvider.create(account);
    }

    if (account.provider === "xai-api-key") {
        return XaiApiKeyProvider.create(account);
    }

    if (account.provider === "openai") {
        return OpenAiApiKeyProvider.create(account);
    }

    throw new Error(`Provider not implemented yet: ${account.provider}`);
}

/**
 * Fetch the cached provider for a resolved route, recreating it when the
 * account config changed (fingerprint mismatch) or it was never built. Returns
 * null when the provider cannot be created.
 */
export async function acquireProvider(
    providers: Map<string, ProxyProvider>,
    route: { accountName: string; providerSlug: string; account: AiProxyAccountConfig }
): Promise<ProxyProvider | null> {
    const key = routeProviderKey(route);
    const fingerprint = accountConfigFingerprint(route.account);
    let provider = providers.get(key);

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
export function providerUnavailableResponse(route: { accountName: string; providerSlug: string }): Response {
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
