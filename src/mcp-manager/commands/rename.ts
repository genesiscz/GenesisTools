import logger from "@app/logger";
import { readUnifiedConfig, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
import { WriteResult } from "@app/mcp-manager/utils/providers/types.js";
import { DiffUtil } from "@app/utils/diff";
import { ExitPromptError } from "@inquirer/core";
import { checkbox, confirm, input, search } from "@inquirer/prompts";
import chalk from "chalk";

/**
 * Rename an MCP server key across unified config and all providers
 */
export async function renameServer(
    oldName: string | undefined,
    newName: string | undefined,
    providers: MCPProvider[],
): Promise<void> {
    const config = await readUnifiedConfig();

    if (Object.keys(config.mcpServers).length === 0) {
        logger.warn("No servers found in unified config.");
        return;
    }

    // Get old name - from args or prompt
    let finalOldName = oldName;
    if (!finalOldName) {
        const serverNames = Object.keys(config.mcpServers).sort();
        try {
            const selectedOldName = await search({
                message: "Select server to rename:",
                source: async (term) => {
                    if (!term) {
                        return serverNames.map((name) => ({ value: name, name }));
                    }
                    const lowerTerm = term.toLowerCase();
                    return serverNames
                        .filter((name) => name.toLowerCase().includes(lowerTerm))
                        .map((name) => ({ value: name, name }));
                },
                pageSize: 30,
            });

            finalOldName = selectedOldName.trim();
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info("\nOperation cancelled by user.");
                return;
            }
            throw error;
        }
    }

    // Validate old name exists
    if (!config.mcpServers[finalOldName]) {
        logger.error(`Server '${finalOldName}' not found in unified config.`);
        return;
    }

    // Get new name - from args or prompt
    let finalNewName = newName;
    if (!finalNewName) {
        try {
            const inputNewName = await input({
                message: `Enter new name for '${finalOldName}':`,
                default: finalOldName,
            });

            finalNewName = inputNewName.trim();
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info("\nOperation cancelled by user.");
                return;
            }
            throw error;
        }
    }

    if (!finalNewName) {
        logger.warn("New name cannot be empty.");
        return;
    }

    if (finalOldName === finalNewName) {
        logger.warn("Old name and new name are the same. No changes needed.");
        return;
    }

    // Check for conflict in unified config
    const hasConflictInUnified = !!config.mcpServers[finalNewName];
    if (hasConflictInUnified) {
        logger.warn(`\n⚠ Conflict detected: Server '${finalNewName}' already exists in unified config.`);

        const oldServerConfig = JSON.stringify(config.mcpServers[finalOldName], null, 2);
        const existingServerConfig = JSON.stringify(config.mcpServers[finalNewName], null, 2);

        logger.info(chalk.bold(`\nExisting server '${finalNewName}' configuration:`));
        logger.info(existingServerConfig);
        logger.info(chalk.bold(`\nServer '${finalOldName}' configuration (will replace):`));
        logger.info(oldServerConfig);

        // Show diff
        await DiffUtil.showDiff(
            existingServerConfig,
            oldServerConfig,
            `existing '${finalNewName}'`,
            `'${finalOldName}' (will replace)`,
        );

        try {
            const confirmed = await confirm({
                message: `Replace existing server '${finalNewName}' with '${finalOldName}'?`,
                default: false,
            });

            if (!confirmed) {
                logger.info("Rename cancelled by user.");
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

    // Perform rename in unified config
    const serverConfig = config.mcpServers[finalOldName];

    // Rename the server key (this preserves _meta automatically)
    config.mcpServers[finalNewName] = serverConfig;
    delete config.mcpServers[finalOldName];

    // Update enabledMcpServers if it exists
    // Move enabled state from old name to new name (replacing if new name already exists)
    if (config.enabledMcpServers) {
        if (config.enabledMcpServers[finalOldName]) {
            config.enabledMcpServers[finalNewName] = config.enabledMcpServers[finalOldName];
            delete config.enabledMcpServers[finalOldName];
        }
    }

    // Write unified config
    const written = await writeUnifiedConfig(config);
    if (!written) {
        // User cancelled or no changes - don't proceed with provider sync
        return;
    }
    logger.info(`✓ Renamed '${finalOldName}' to '${finalNewName}' in unified config`);

    // Sync to providers
    const availableProviders = providers.filter((p) => p.configExists());

    if (availableProviders.length === 0) {
        logger.warn("No provider configuration files found.");
        return;
    }

    // Select providers to sync to
    let selectedProviderNames: string[];
    try {
        selectedProviderNames = await checkbox({
            message: "Select providers to sync rename to:",
            choices: availableProviders.map((p) => ({
                value: p.getName(),
                name: `${p.getName()} (${p.getConfigPath()})`,
            })),
        });
    } catch (error) {
        if (error instanceof ExitPromptError) {
            logger.info("\nOperation cancelled by user.");
            return;
        }
        throw error;
    }

    if (selectedProviderNames.length === 0) {
        logger.info("No providers selected. Rename completed in unified config only.");
        return;
    }

    // Sync rename to each selected provider
    for (const providerName of selectedProviderNames) {
        const provider = providers.find((p) => p.getName() === providerName);
        if (!provider) {
            continue;
        }

        try {
            await renameServerInProvider(provider, finalOldName, finalNewName, serverConfig);
            logger.info(`✓ Renamed '${finalOldName}' to '${finalNewName}' in ${providerName}`);
        } catch (error: unknown) {
            if (error instanceof Error) {
                logger.error(`✗ Failed to rename in ${providerName}: ${error.message}`);
            }
        }
    }
}

/**
 * Rename a server in a specific provider
 */
async function renameServerInProvider(
    provider: MCPProvider,
    oldName: string,
    newName: string,
    serverConfig: unknown,
): Promise<void> {
    // Check if provider has the old or new server
    const providerServers = await provider.listServers();
    const hasOldServer = providerServers.some((s) => s.name === oldName);
    const hasNewServer = providerServers.some((s) => s.name === newName);

    if (!hasOldServer && !hasNewServer) {
        // Server doesn't exist in this provider, skip
        return;
    }

    // Convert provider config to unified format to check for conflicts
    const config = await provider.readConfig();
    const unifiedServers = provider.toUnifiedConfig(config);

    // Check for conflict - if new name already exists in provider
    if (hasNewServer && unifiedServers[newName]) {
        // Show diff for this provider
        const existingConfig = JSON.stringify(unifiedServers[newName], null, 2);
        const replacingConfig = JSON.stringify(serverConfig, null, 2);

        logger.warn(`\n⚠ Conflict in ${provider.getName()}: Server '${newName}' already exists.`);

        await DiffUtil.showDiff(
            existingConfig,
            replacingConfig,
            `existing '${newName}' in ${provider.getName()}`,
            `'${oldName}' (will replace)`,
        );

        try {
            const confirmed = await confirm({
                message: `Replace existing server '${newName}' in ${provider.getName()}?`,
                default: false,
            });

            if (!confirmed) {
                logger.info(`Skipping rename in ${provider.getName()}.`);
                return;
            }
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info(`\nSkipping rename in ${provider.getName()}.`);
                return;
            }
            throw error;
        }
    }

    // Prepare unified servers map with renamed server
    // Start with current unified servers (keep _meta intact for enabled state)
    const serversToSync: Record<string, unknown> = { ...unifiedServers };

    // If old server exists, rename it to new name
    if (serversToSync[oldName]) {
        serversToSync[newName] = serversToSync[oldName];
        delete serversToSync[oldName];
    } else {
        // Old server doesn't exist, but we want to add the new one
        serversToSync[newName] = serverConfig;
    }

    // Now sync the updated servers to the provider (adds/updates the new name)
    // Provider reads _meta.enabled[providerName] for enabled state
    const syncResult = await provider.syncServers(
        serversToSync as Record<string, import("../utils/providers/types.js").UnifiedMCPServerConfig>,
    );

    if (syncResult === WriteResult.Rejected) {
        logger.info(`Skipped ${provider.getName()} - user rejected confirmation`);
        return;
    }

    // IMPORTANT: syncServers only adds/updates servers, it doesn't remove servers not in the map
    // We need to explicitly remove the old server name from the provider config after syncing
    if (hasOldServer && oldName !== newName) {
        await removeServerFromProvider(provider, oldName);
    }
}

/**
 * Remove a server from a provider's configuration
 */
async function removeServerFromProvider(provider: MCPProvider, serverName: string): Promise<void> {
    const config = await provider.readConfig();
    const providerName = provider.getName();

    // Remove server based on provider-specific structure
    switch (providerName) {
        case "claude": {
            const claudeConfig = config as Record<string, unknown>;
            // Remove from global mcpServers
            if ((claudeConfig.mcpServers as Record<string, unknown>)?.[serverName]) {
                delete (claudeConfig.mcpServers as Record<string, unknown>)[serverName];
            }
            // Remove from disabledMcpServers array
            if (claudeConfig.disabledMcpServers) {
                claudeConfig.disabledMcpServers = (claudeConfig.disabledMcpServers as string[]).filter(
                    (name: string) => name !== serverName,
                );
            }
            // Remove from project-specific configs
            if (claudeConfig.projects) {
                for (const projectConfig of Object.values(claudeConfig.projects) as Record<string, unknown>[]) {
                    if ((projectConfig.mcpServers as Record<string, unknown>)?.[serverName]) {
                        delete (projectConfig.mcpServers as Record<string, unknown>)[serverName];
                    }
                    if (projectConfig.disabledMcpServers) {
                        projectConfig.disabledMcpServers = (projectConfig.disabledMcpServers as string[]).filter(
                            (name: string) => name !== serverName,
                        );
                    }
                }
            }
            await provider.writeConfig(claudeConfig);
            break;
        }
        case "codex": {
            const codexConfig = config as Record<string, unknown>;
            if ((codexConfig.mcp_servers as Record<string, unknown>)?.[serverName]) {
                delete (codexConfig.mcp_servers as Record<string, unknown>)[serverName];
            }
            await provider.writeConfig(codexConfig);
            break;
        }
        case "cursor": {
            const cursorConfig = config as Record<string, unknown>;
            if ((cursorConfig.mcpServers as Record<string, unknown>)?.[serverName]) {
                delete (cursorConfig.mcpServers as Record<string, unknown>)[serverName];
            }
            await provider.writeConfig(cursorConfig);
            break;
        }
        case "gemini": {
            const geminiConfig = config as Record<string, unknown>;
            // Remove from mcpServers
            if ((geminiConfig.mcpServers as Record<string, unknown>)?.[serverName]) {
                delete (geminiConfig.mcpServers as Record<string, unknown>)[serverName];
            }
            // Remove from excluded list
            if ((geminiConfig.mcp as Record<string, unknown>)?.excluded) {
                (geminiConfig.mcp as Record<string, unknown>).excluded = (
                    (geminiConfig.mcp as Record<string, unknown>).excluded as string[]
                ).filter((name: string) => name !== serverName);
            }
            await provider.writeConfig(geminiConfig);
            break;
        }
        default:
            logger.warn(`Unknown provider: ${providerName}. Cannot remove server.`);
    }
}
