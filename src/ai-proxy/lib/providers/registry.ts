import { AnthropicSubscriptionProvider } from "@app/ai-proxy/lib/providers/anthropic-subscription";
import { GithubCopilotSubscriptionProvider } from "@app/ai-proxy/lib/providers/github-copilot-subscription";
import { GrokSubscriptionProvider } from "@app/ai-proxy/lib/providers/grok-subscription";
import { OpenAiSubscriptionProvider } from "@app/ai-proxy/lib/providers/openai-subscription";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { AiProxyAccountConfig } from "@app/ai-proxy/lib/types";
import { logger } from "@app/logger";

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
        provider === "openai-subscription"
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

    throw new Error(`Provider not implemented yet: ${account.provider}`);
}

export async function tryCreateProvider(account: AiProxyAccountConfig): Promise<ProxyProvider | null> {
    if (!account.enabled || !isProviderImplemented(account.provider)) {
        if (account.enabled && !isProviderImplemented(account.provider)) {
            logger.warn(
                { account: account.name, provider: account.provider },
                "ai-proxy: skipping unimplemented provider at runtime"
            );
        }

        return null;
    }

    return createProvider(account);
}
