import { checkbox } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import logger from "@app/logger";
import { WriteResult } from "../utils/providers/types.js";
import type { MCPProvider } from "../utils/providers/types.js";
import { readUnifiedConfig, stripMeta } from "../utils/config.utils.js";

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
    } else {
        try {
            selectedProviders = await checkbox({
                message: "Select providers to sync to:",
                choices: availableProviders.map((p) => ({
                    value: p.getName(),
                    name: `${p.getName()} (${p.getConfigPath()})`,
                })),
            });

            if (selectedProviders.length === 0) {
                logger.info("No providers selected. Cancelled.");
                return;
            }
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info("\nOperation cancelled by user.");
                return;
            }
            throw error;
        }
    }

    // For each provider, ensure servers are installed and properly synced
    for (const providerName of selectedProviders) {
        const provider = availableProviders.find((p) => p.getName() === providerName);
        if (!provider) continue;

        try {
            logger.info(`Syncing to ${providerName}...`);

            // First, install servers that need to be in this provider's config
            for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
                const existingServerConfig = await provider.getServerConfig(serverName);
                if (!existingServerConfig) {
                    // For providers without native disable (Cursor/Codex), only install if enabled
                    if (!provider.supportsDisabledState()) {
                        const isEnabled = provider.isServerEnabledInMeta(serverConfig);
                        if (!isEnabled) {
                            continue; // Skip - will be handled (deleted) by syncServers
                        }
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
