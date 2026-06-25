import { buildProviderMap, providerKey } from "@app/ai-proxy/lib/providers/registry";
import type { ProxyProvider } from "@app/ai-proxy/lib/providers/types";
import type { AiProxyAccountConfig, AiProxyConfig, SubscriptionUsageDetails } from "@app/ai-proxy/lib/types";
import { billingSnapshotIsStale, readBillingStore, saveBillingSnapshot } from "@app/ai-proxy/lib/usage/store";
import type { AccountBillingSnapshot } from "@app/ai-proxy/lib/usage/types";
import { logger } from "@app/logger";

const syncInFlight = new Set<string>();

const SUBSCRIPTION_PROVIDERS = new Set<AiProxyAccountConfig["provider"]>([
    "grok-subscription",
    "github-copilot-subscription",
]);

export function snapshotFromUsage(
    account: AiProxyAccountConfig,
    input: { tier?: string; summary: string; details?: SubscriptionUsageDetails }
): AccountBillingSnapshot | null {
    if (account.provider === "grok-subscription") {
        const grok = input.details?.grok;
        if (!grok?.billing) {
            return null;
        }

        return {
            fetchedAt: new Date().toISOString(),
            tier: input.tier,
            summary: input.summary,
            grok,
        };
    }

    if (account.provider === "github-copilot-subscription") {
        const copilot = input.details?.copilot;
        if (!copilot) {
            return null;
        }

        return {
            fetchedAt: new Date().toISOString(),
            tier: input.tier,
            summary: input.summary,
            copilot,
        };
    }

    return null;
}

export async function maybeSyncBilling(
    account: AiProxyAccountConfig,
    providers: Map<string, ProxyProvider>
): Promise<void> {
    if (!SUBSCRIPTION_PROVIDERS.has(account.provider)) {
        return;
    }

    const store = readBillingStore();
    const snapshot = store.accounts[account.name];

    if (!billingSnapshotIsStale(snapshot)) {
        return;
    }

    if (syncInFlight.has(account.name)) {
        return;
    }

    syncInFlight.add(account.name);

    try {
        const key = providerKey(account);
        const provider = providers.get(key);

        if (!provider) {
            logger.debug(
                { account: account.name, providerKey: key },
                "ai-proxy usage: billing sync skipped, provider missing"
            );
            return;
        }

        const usage = await provider.getUsage();
        const nextSnapshot = snapshotFromUsage(account, usage);

        if (!nextSnapshot) {
            logger.warn(
                { account: account.name, provider: account.provider },
                "ai-proxy usage: billing sync missing provider payload"
            );
            return;
        }

        saveBillingSnapshot(account.name, nextSnapshot);
    } catch (err) {
        logger.warn({ err, account: account.name }, "ai-proxy usage: billing sync failed");
    } finally {
        syncInFlight.delete(account.name);
    }
}

export function scheduleBillingSync(account: AiProxyAccountConfig, providers: Map<string, ProxyProvider>): void {
    void maybeSyncBilling(account, providers).catch((err) => {
        logger.warn({ err, account: account.name }, "ai-proxy usage: background billing sync failed");
    });
}

export async function syncBillingForConfig(config: AiProxyConfig): Promise<void> {
    const providers = await buildProviderMap(config.accounts, (account) =>
        SUBSCRIPTION_PROVIDERS.has(account.provider)
    );

    for (const account of config.accounts) {
        if (!account.enabled || !SUBSCRIPTION_PROVIDERS.has(account.provider)) {
            continue;
        }

        await maybeSyncBilling(account, providers);
    }
}

export function scheduleBillingSyncForConfig(config: AiProxyConfig): void {
    void syncBillingForConfig(config).catch((err) => {
        logger.warn({ err }, "ai-proxy usage: startup billing sync failed");
    });
}
