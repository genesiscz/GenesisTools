import logger from "@app/logger";
import type { MCPProvider } from "../utils/providers/types.js";
import type { MCPProviderName } from "../utils/types.js";
import { readUnifiedConfig, writeUnifiedConfig, stripMeta } from "../utils/config.utils.js";
import { getServerNames, promptForProviders, promptForProjects } from "../utils/command.utils.js";

/**
 * Enable MCP server(s) in selected provider(s)
 */
export async function enableServer(serverNameArg: string | undefined, providers: MCPProvider[]): Promise<void> {
    // Read unified config to get available servers
    const config = await readUnifiedConfig();

    if (Object.keys(config.mcpServers).length === 0) {
        logger.warn("No servers found in unified config. Run 'tools mcp-manager config' to add servers.");
        return;
    }

    // Get server names from args or prompt
    const finalServerNames = await getServerNames(serverNameArg, config, "Select servers to enable:");
    if (!finalServerNames || finalServerNames.length === 0) {
        logger.info("No servers selected.");
        return;
    }

    // Get all available providers (those with config files)
    const availableProviders = providers.filter((p) => p.configExists());

    // Prompt for providers to enable in
    const selectedProviderNames = await promptForProviders(
        availableProviders,
        "Select providers to enable server(s) in:"
    );
    if (!selectedProviderNames || selectedProviderNames.length === 0) {
        logger.info("No providers selected.");
        return;
    }

    // For each provider, check if it supports projects and prompt for project selection
    for (const providerName of selectedProviderNames) {
        const provider = availableProviders.find((p) => p.getName() === providerName);
        if (!provider) continue;

        // Check if provider supports projects
        const projects = await provider.getProjects();
        let projectChoices: Array<{ projectPath: string | null; displayName: string }> | null = null;

        if (projects.length > 0) {
            // Provider supports projects - prompt for selection
            projectChoices = await promptForProjects(
                projects,
                `Select projects for ${providerName} (or "Global" for all):`
            );

            if (!projectChoices || projectChoices.length === 0) {
                logger.info(`No projects selected for ${providerName}.`);
                continue;
            }
        }

        // Collect servers to enable and install any missing ones
        const serversToEnable: string[] = [];
        for (const serverName of finalServerNames) {
            let serverConfig = config.mcpServers[serverName];

            // If server not in unified config, try to import it from provider first
            if (!serverConfig) {
                logger.info(
                    `Server '${serverName}' not found in unified config. Attempting to import from ${providerName}...`
                );
                const providerServerInfo = await provider.getServerConfig(serverName);
                if (providerServerInfo) {
                    // Import server config and add to unified config
                    serverConfig = providerServerInfo;
                    config.mcpServers[serverName] = serverConfig;
                    logger.info(`✓ Imported '${serverName}' to unified config`);
                } else {
                    logger.warn(`Server '${serverName}' not found in ${providerName} either. Skipping.`);
                    continue;
                }
            }

            try {
                // Strip _meta before syncing to provider
                const configToSync = stripMeta(serverConfig);

                // Check if server is installed globally in provider - if not, install it automatically
                const existingServerConfig = await provider.getServerConfig(serverName);
                if (!existingServerConfig) {
                    // Server not installed globally - install it first
                    logger.info(`Installing '${serverName}' globally in ${providerName}...`);
                    await provider.installServer(serverName, configToSync);
                }

                serversToEnable.push(serverName);

                // Update _meta.enabled in unified config (source of truth)
                if (!config.mcpServers[serverName]._meta) {
                    config.mcpServers[serverName]._meta = { enabled: {} };
                }
                if (!config.mcpServers[serverName]._meta!.enabled) {
                    config.mcpServers[serverName]._meta!.enabled = {};
                }
                // Mark as enabled for this provider (global enablement)
                config.mcpServers[serverName]._meta!.enabled[providerName as MCPProviderName] = true;
            } catch (error: any) {
                logger.error(`✗ Failed to prepare '${serverName}' for enabling in ${providerName}: ${error.message}`);
            }
        }

        // Batch enable all servers in this provider (one backup, one diff, one save)
        if (serversToEnable.length > 0) {
            try {
                if (projectChoices) {
                    // Enable for each project selection
                    for (const projectChoice of projectChoices) {
                        await provider.enableServers(serversToEnable, projectChoice.projectPath);
                        if (projectChoice.projectPath === null) {
                            logger.info(`✓ Enabled ${serversToEnable.length} server(s) globally in ${providerName}`);
                        } else {
                            logger.info(
                                `✓ Enabled ${serversToEnable.length} server(s) in ${providerName} for project: ${projectChoice.displayName}`
                            );
                        }
                    }
                } else {
                    // No projects - just enable globally
                    await provider.enableServers(serversToEnable);
                    logger.info(`✓ Enabled ${serversToEnable.length} server(s) globally in ${providerName}`);
                }
            } catch (error: any) {
                logger.error(`✗ Failed to enable servers in ${providerName}: ${error.message}`);
            }
        }
    }

    // Write updated config with _meta changes
    await writeUnifiedConfig(config);
}
