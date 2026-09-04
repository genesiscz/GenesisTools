import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { showsInUsageDashboard } from "@genesiscz/utils/ai/config/selectors";
import type { UsagePresenters } from "@genesiscz/utils/ai/providers/account-features";
import { resolveProviderAlias } from "@genesiscz/utils/ai/providers/aliases";
import { loadDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import { pollAccounts, usagePlugins } from "@genesiscz/utils/ai/usage-poll/poll";
import { logger } from "@genesiscz/utils/logger";
import type { UsageDataSource } from "./types";

export interface BuildUsageDataSourceOptions {
    /**
     * Plugin ids or CLI aliases the dashboard is pinned to. Omitted means every provider
     * that declares `accounts.usage`, which is what `tools ai usage` wants.
     */
    providers?: string[];
    /**
     * Ink presenters by plugin id. Supplied by the COMMAND, not read off the plugin: a
     * presenter is a React component, and holding one on the plugin object would pull Ink
     * and React into every `tools ai config` invocation that only reads an account.
     */
    presenters?: Record<string, UsagePresenters | undefined>;
    extraTabs?: UsageDataSource["extraTabs"];
}

/**
 * The one `UsageDataSource` builder behind all four usage commands (spec 7.2, 7.5).
 * `tools ai usage` passes no providers, `tools claude usage` pins `anthropic-sub` and adds
 * the Sessions tab, `tools codex usage` and `tools grok usage` pin their own id.
 */
export async function buildUsageDataSource(opts: BuildUsageDataSourceOptions = {}): Promise<UsageDataSource> {
    const providers = (
        opts.providers?.map((p) => resolveProviderAlias(p)) ?? usagePlugins().map((entry) => entry.plugin.id)
    ).sort();
    const config = await loadDashboardConfig();
    const hidden = new Set(config.hiddenAccounts);
    let limitsDb: UsageLimitsDb | null = null;

    try {
        limitsDb = new UsageLimitsDb();
    } catch (err) {
        // The History tab degrades to "no data"; the Overview tab is live and does not
        // need the store, so a broken database must not take the whole dashboard down.
        logger.warn({ err }, "[ai-usage] limits store unavailable; History tab will be empty");
    }

    return {
        providers,
        poll: (pollOpts) =>
            pollAccounts({
                providers,
                ...(pollOpts.force === undefined ? {} : { force: pollOpts.force }),
                ...(pollOpts.accountFilter === undefined ? {} : { accountFilter: pollOpts.accountFilter }),
            }),
        // Re-read every round, so an account renamed or logged out in another terminal
        // shows up without restarting the TUI.
        accounts: async () => {
            const store = await AiConfigStore.load();

            return store
                .accounts()
                .filter(
                    (account) =>
                        providers.includes(account.provider) &&
                        showsInUsageDashboard(account) &&
                        !hidden.has(account.name)
                )
                .map((account) => ({
                    id: account.id,
                    name: account.name,
                    provider: account.provider,
                    ...(account.label === undefined ? {} : { label: account.label }),
                }));
        },
        limitsDb,
        config,
        presenters: opts.presenters ?? {},
        ...(opts.extraTabs === undefined ? {} : { extraTabs: opts.extraTabs }),
    };
}
