import logger from "@app/logger";
import type { MCPProvider } from "../utils/providers/types.js";
import type { MCPProviderName } from "../utils/types.js";
import { readUnifiedConfig, writeUnifiedConfig } from "../utils/config.utils.js";
import { getServerNames, promptForProviders, promptForProjects } from "../utils/command.utils.js";

/**
 * Disable MCP server(s) in selected provider(s)
 */
export async function disableServer(serverNameArg: string | undefined, providers: MCPProvider[]): Promise<void> {
    // Read unified config to get available servers
    const config = await readUnifiedConfig();

    if (Object.keys(config.mcpServers).length === 0) {
        logger.warn("No servers found in unified config. Run 'tools mcp-manager config' to add servers.");
        return;
    }

    // Get server names from args or prompt
    const finalServerNames = await getServerNames(serverNameArg, config, "Select servers to disable:");
    if (!finalServerNames || finalServerNames.length === 0) {
        logger.info("No servers selected.");
        return;
    }

    // Get all available providers (those with config files)
    const availableProviders = providers.filter((p) => p.configExists());

    // Prompt for providers to disable from
    const selectedProviderNames = await promptForProviders(
        availableProviders,
        "Select providers to disable server(s) from:"
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

        // Collect servers to disable (they only need to exist in unified config)
        const serversToDisable: string[] = [];
        for (const serverName of finalServerNames) {
            const serverConfig = config.mcpServers[serverName];

            // Server must exist in unified config to be disabled
            if (!serverConfig) {
                logger.warn(
                    `Server '${serverName}' not found in unified config. Run 'tools mcp-manager config' to add it first.`
                );
                continue;
            }

            // Add to disable list - disabledMcpServers is a blocklist that can contain
            // servers that don't exist in the provider's mcpServers yet (they may be installed later)
            serversToDisable.push(serverName);

            // Update _meta.enabled in unified config (source of truth)
            if (!config.mcpServers[serverName]._meta) {
                config.mcpServers[serverName]._meta = { enabled: {} };
            }
            if (!config.mcpServers[serverName]._meta!.enabled) {
                config.mcpServers[serverName]._meta!.enabled = {};
            }
            // Mark as disabled for this provider
            config.mcpServers[serverName]._meta!.enabled[providerName as MCPProviderName] = false;
        }

        // Batch disable all servers in this provider (one backup, one diff, one save)
        if (serversToDisable.length > 0) {
            try {
                if (projectChoices) {
                    // Disable for each project selection
                    for (const projectChoice of projectChoices) {
                        await provider.disableServers(serversToDisable, projectChoice.projectPath);
                        if (projectChoice.projectPath === null) {
                            logger.info(`✓ Disabled ${serversToDisable.length} server(s) globally in ${providerName}`);
                        } else {
                            logger.info(
                                `✓ Disabled ${serversToDisable.length} server(s) in ${providerName} for project: ${projectChoice.displayName}`
                            );
                        }
                    }
                } else {
                    // No projects - just disable globally
                    await provider.disableServers(serversToDisable);
                    logger.info(`✓ Disabled ${serversToDisable.length} server(s) globally in ${providerName}`);
                }
            } catch (error: any) {
                logger.error(`✗ Failed to disable servers in ${providerName}: ${error.message}`);
            }
        }
    }

    // Write updated config with _meta changes
    await writeUnifiedConfig(config);
}
