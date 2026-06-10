import { logger } from "@app/logger";
import { readUnifiedConfig, stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
import { WriteResult } from "@app/mcp-manager/utils/providers/types.js";
import { isInteractive, suggestCommand } from "@app/utils/cli";
import * as p from "@app/utils/prompts/p";

export interface SyncOptions {
    provider?: string; // Provider name(s), comma-separated for non-interactive mode
}

/**
 * Sync servers from unified config to selected providers.
 * Providers read _meta.enabled[providerName] to determine enabled state.
 * Ensures servers are installed and properly enabled/disabled in each provider.
 */
export async function syncServers(providers: MCPProvider[], options: SyncOptions = {}): Promise<void> {
    const config = await readUnifiedConfig();

    if (Object.keys(config.mcpServers).length === 0) {
        logger.warn("No servers found in unified config. Run 'tools mcp-manager config' to add servers.");
        return;
    }

    // Filter providers that have config files
    const availableProviders: MCPProvider[] = [];
    for (const provider of providers) {
        if (await provider.configExists()) {
            availableProviders.push(provider);
        }
    }

    if (availableProviders.length === 0) {
        logger.warn("No provider configuration files found.");
        return;
    }

    let selectedProviders: string[];
    if (options.provider) {
        // NOTE: availableProviders is already pre-filtered by parseProviderArg() in index.ts
        // before being passed to this function, so we select all providers here since they
        // are already the subset that was requested via --provider flag.
        selectedProviders = availableProviders.map((p) => p.getName());
    } else if (!isInteractive()) {
        const names = availableProviders.map((p) => p.getName()).join(", ");
        logger.error(`--provider required in non-interactive mode. Available: ${names}`);
        logger.info(suggestCommand("tools mcp-manager", { add: ["--provider", "all"] }));
        process.exit(1);
    } else {
        selectedProviders = (await p.multiselect({
            message: "Select providers to sync to:",
            options: availableProviders.map((prov) => ({
                value: prov.getName(),
                label: `${prov.getName()} (${prov.getConfigPath()})`,
            })),
        })) as string[];

        if (selectedProviders.length === 0) {
            logger.info("No providers selected. Cancelled.");
            return;
        }
    }

    // For each provider, ensure servers are installed and properly synced
    for (const providerName of selectedProviders) {
        const provider = availableProviders.find((p) => p.getName() === providerName);
        if (!provider) {
            continue;
        }

        try {
            logger.info(`Syncing to ${providerName}...`);

            // First, install servers that need to be in this provider's config
            for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
                const existingServerConfig = await provider.getServerConfig(serverName);
                if (!existingServerConfig) {
                    // Skip servers that must stay absent from this provider's
                    // config: Cursor/Codex have no disabled state (presence =
                    // enabled), and Claude's only TRUE global disable is
                    // absence from ~/.claude.json mcpServers.
                    if (!provider.shouldBeInstalled(serverConfig)) {
                        continue; // Skip - will be handled (deleted) by syncServers
                    }
                    logger.info(`  Installing '${serverName}' in ${providerName}...`);
                    const configToInstall = stripMeta(serverConfig);
                    await provider.installServer(serverName, configToInstall);
                }
            }

            // Sync all servers (with enabled/disabled state from _meta.enabled[providerName])
            const syncResult = await provider.syncServers(config.mcpServers);
            if (syncResult === WriteResult.Applied) {
                logger.info(`✓ Synced to ${providerName}`);
            } else if (syncResult === WriteResult.Rejected) {
                logger.info(`Skipped ${providerName} - user rejected confirmation`);
            }
        } catch (error: unknown) {
            if (error instanceof Error) {
                logger.error(`✗ Failed to sync to ${providerName}: ${error.message}`);
            }
        }
    }
}
