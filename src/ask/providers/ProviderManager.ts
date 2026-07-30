import { askUI } from "@ask/output/AskUILogger";
import type { DetectedProvider, ModelInfo, ProviderConfig } from "@ask/types";
import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { ephemeralEnvAccounts } from "@genesiscz/utils/ai/config/migrations/2026-08-seedEnvAccounts";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { describeCredential } from "@genesiscz/utils/ai/providers/credentials";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { tryProviderPlugin } from "@genesiscz/utils/ai/providers/registry";
import { getProviderConfigs } from "@genesiscz/utils/ask/providers/compat";
import { modelsForProvider, providerNameFor, toDetectedProvider } from "@genesiscz/utils/ask/providers/detected";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";

/**
 * Which providers can `ask` use right now?
 *
 * The answer used to be assembled from four disagreeing sources: a hand-kept
 * `PROVIDER_CONFIGS` table, three per-vendor subscription branches, a resolver
 * registry reached through dynamic imports, and live `/v1/models` calls. Now it
 * is one walk over the unified AI config: every enabled account, bound through
 * its provider plugin, with models read from the catalog. Adding a provider is a
 * plugin, not an edit here.
 *
 * `DetectedProvider` is deliberately unchanged — `AIChat`, the pricing table and
 * youtube all speak it — so this is a swap of the machine behind the shape.
 */

/**
 * Which key does provider detection spend? Configured account first,
 * environment second.
 *
 * The live ladder is now `resolveCredential`
 * (src/utils/ai/providers/credentials.ts), which applies this same order for
 * every provider and names the variable it spent. This function stays because
 * the deprecated v3 `AIConfig` facade still resolves keys this way and its order
 * is pinned by a unit test: the line decides whose money a call costs.
 */
export function detectApiKeyFor(
    aiConfig: { getProviderApiKey(name: string): string | undefined },
    config: Pick<ProviderConfig, "name" | "envKey">
): string | undefined {
    return aiConfig.getProviderApiKey(config.name) ?? env.ai.getByEnvKey(config.envKey);
}

/** Priority from the compat table, so the familiar openai → groq → … order survives. */
function providerPriority(providerName: string): number {
    const config = getProviderConfigs().find((entry) => entry.name === providerName);
    return config?.priority ?? 99;
}

export class ProviderManager {
    private detectedProviders: Map<string, DetectedProvider> = new Map();
    /**
     * Set only by a scan that was allowed to look at EVERY provider. A targeted
     * scan skips every account whose provider is not the requested one, so
     * marking its result complete would hide the rest for the life of the
     * process. That is exactly what happened in the long-lived youtube server:
     * one `resolveProviderChoice({fallbackSpec: "xai/…"})` — a cost estimate was
     * enough — left `/api/v1/models` serving an xai-only catalog until restart.
     */
    private scannedAll = false;

    async detectProviders(targetProvider?: string): Promise<DetectedProvider[]> {
        if (this.scannedAll || (targetProvider && this.detectedProviders.has(targetProvider))) {
            return Array.from(this.detectedProviders.values());
        }

        registerBuiltInPlugins();

        const store = await AiConfigStore.load();
        const config = store.data();
        const disabled = new Set(config.disabledProviders ?? []);

        for (const account of this.candidateAccounts(store, config)) {
            const name = providerNameFor(account.provider);

            if (targetProvider && name !== targetProvider) {
                continue;
            }

            if (this.detectedProviders.has(name) || disabled.has(account.provider)) {
                continue;
            }

            const plugin = tryProviderPlugin(account.provider);

            if (!plugin?.capabilities.has("chat")) {
                logger.debug(
                    { account: account.name, provider: account.provider },
                    plugin ? "account skipped: provider cannot chat" : "account skipped: no plugin for its provider"
                );
                continue;
            }

            const provider = await this.detectAccount(account, plugin);

            if (provider) {
                this.detectedProviders.set(name, provider);
            }
        }

        // Only a full scan may be cached as complete.
        if (!targetProvider) {
            this.scannedAll = true;
        }

        // The map, not just what THIS pass added: this scan skipped every probe an
        // earlier targeted scan already cached, so returning only the new finds
        // would hand the first full-catalog caller a short list.
        const detected = Array.from(this.detectedProviders.values());

        if (detected.length === 0) {
            logger.warn("No AI providers detected.");
            logger.info("Add one with: tools ai config account add --provider <provider>");
        }

        return detected;
    }

    /**
     * Enabled accounts, then the grandfathered environment entries.
     *
     * Real accounts first is what keeps a configured Claude Max subscription
     * outranking a stray `ANTHROPIC_API_KEY`, which is the priority the old
     * per-vendor branch spelled out by hand for anthropic alone.
     */
    private candidateAccounts(store: AiConfigStore, config: ReturnType<AiConfigStore["data"]>): AccountEntry[] {
        const preferred = config.defaults.account?.chat?.slice("@account/".length);
        const real = store.accounts({ enabled: true }).sort((a, b) => {
            if ((a.id === preferred) !== (b.id === preferred)) {
                return a.id === preferred ? -1 : 1;
            }

            return providerPriority(providerNameFor(a.provider)) - providerPriority(providerNameFor(b.provider));
        });

        return [...real, ...ephemeralEnvAccounts(config)];
    }

    private async detectAccount(account: AccountEntry, plugin: ProviderPlugin): Promise<DetectedProvider | null> {
        const credential = await describeCredential(account, plugin.credential);

        if (!credential.ok) {
            logger.debug(
                { account: account.name, provider: account.provider, detail: credential.detail },
                "account skipped: no usable credential"
            );
            return null;
        }

        try {
            const binding = await plugin.bind({ account });
            const models = await modelsForProvider(account.provider);
            const detected = toDetectedProvider({
                binding,
                pluginId: account.provider,
                account: { name: account.name, ...(account.label ? { label: account.label } : {}) },
                models,
                credentialSource: credential.detail,
            });

            if (plugin.kind === "subscription") {
                askUI().logDetectedSubscription({
                    provider: detected.name,
                    hint: account.label ? ` (${account.label})` : "",
                });
            } else {
                askUI().logDetected({ provider: detected.name, count: models.length });
            }

            return detected;
        } catch (error) {
            logger.warn(
                { err: error, account: account.name, provider: account.provider },
                "failed to bind provider for account"
            );
            return null;
        }
    }

    /** Does this provider answer? Delegated to the plugin, which knows what a probe costs. */
    async validateProvider(providerName: string): Promise<boolean> {
        registerBuiltInPlugins();

        const store = await AiConfigStore.load();
        const account = this.candidateAccounts(store, store.data()).find(
            (entry) => providerNameFor(entry.provider) === providerName
        );

        if (!account) {
            logger.warn(`Provider validation failed for ${providerName}: no account resolves to it`);
            return false;
        }

        const plugin = tryProviderPlugin(account.provider);

        if (!plugin) {
            return false;
        }

        if (!plugin.health) {
            // No probe declared: a resolvable credential is the strongest claim
            // available without spending a request.
            const credential = await describeCredential(account, plugin.credential);
            return credential.ok;
        }

        const report = await plugin.health({ account, probe: true });

        if (!report.ok) {
            logger.warn(`Provider validation failed for ${providerName}: ${report.detail}`);
        }

        return report.ok;
    }

    getProvider(name: string): DetectedProvider | undefined {
        return this.detectedProviders.get(name);
    }

    getAvailableProviders(): DetectedProvider[] {
        return Array.from(this.detectedProviders.values());
    }

    async getModelsForProvider(providerName: string): Promise<ModelInfo[]> {
        const provider = this.getProvider(providerName);
        return provider?.models || [];
    }

    /**
     * A fresh subscription provider for one named account, bypassing the cache.
     * `tools claude` uses it to talk as a specific login without disturbing the
     * process-wide detection result.
     */
    async createSubscriptionProvider(accountName: string): Promise<DetectedProvider | null> {
        registerBuiltInPlugins();

        try {
            const store = await AiConfigStore.load();
            const account = store.account(accountName);

            if (!account) {
                logger.warn(`Failed to create subscription provider for "${accountName}": no such account`);
                return null;
            }

            const plugin = tryProviderPlugin(account.provider);

            if (!plugin) {
                logger.warn(
                    `Failed to create subscription provider for "${accountName}": ${account.provider} has no plugin`
                );
                return null;
            }

            const binding = await plugin.bind({ account });

            return toDetectedProvider({
                binding,
                pluginId: account.provider,
                account: { name: account.name, ...(account.label ? { label: account.label } : {}) },
                models: await modelsForProvider(account.provider),
            });
        } catch (err) {
            logger.warn(`Failed to create subscription provider for "${accountName}": ${err}`);
            return null;
        }
    }
}

// Singleton instance
export const providerManager = new ProviderManager();
