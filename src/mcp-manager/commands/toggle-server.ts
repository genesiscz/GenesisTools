import logger from "@app/logger";
import { getServerNames, promptForProjects, promptForProviders } from "@app/mcp-manager/utils/command.utils.js";
import { readUnifiedConfig, stripMeta, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
import { WriteResult } from "@app/mcp-manager/utils/providers/types.js";
import type { MCPProviderName, PerProjectEnabledState } from "@app/mcp-manager/utils/types.js";

export interface ToggleOptions {
    provider?: string; // Provider name for non-interactive mode
}

/**
 * Toggle MCP server(s) enabled/disabled state in selected provider(s)
 * @param enabled - true to enable, false to disable
 * @param serverNameArg - Optional server name from command line
 * @param providers - List of available providers
 * @param options - Additional options for non-interactive mode
 */
export async function toggleServer(
    enabled: boolean,
    serverNameArg: string | undefined,
    providers: MCPProvider[],
    options: ToggleOptions = {}
): Promise<void> {
    const action = enabled ? "enable" : "disable";
    const actionPast = enabled ? "enabled" : "disabled";
    const actionGerund = enabled ? "enabling" : "disabling";

    // Read unified config to get available servers
    const config = await readUnifiedConfig();

    if (Object.keys(config.mcpServers).length === 0) {
        logger.warn("No servers found in unified config. Run 'tools mcp-manager config' to add servers.");
        return;
    }

    // Get server names from args or prompt
    const finalServerNames = await getServerNames(serverNameArg, config, `Select servers to ${action}:`);
    if (!finalServerNames || finalServerNames.length === 0) {
        logger.info("No servers selected.");
        return;
    }

    // Get all available providers (those with config files)
    const availableProviders: MCPProvider[] = [];
    for (const provider of providers) {
        if (await provider.configExists()) {
            availableProviders.push(provider);
        }
    }

    let selectedProviderNames: string[] | null;
    if (options.provider) {
        // Filter to the specified provider
        const matchedProvider = availableProviders.find(
            (p) => p.getName().toLowerCase() === options.provider?.toLowerCase()
        );
        if (!matchedProvider) {
            logger.warn(`Provider '${options.provider}' not found or has no config file.`);
            return;
        }
        selectedProviderNames = [matchedProvider.getName()];
    } else {
        selectedProviderNames = await promptForProviders(
            availableProviders,
            `Select providers to ${action} server(s) in:`
        );
    }

    if (!selectedProviderNames || selectedProviderNames.length === 0) {
        logger.info("No providers selected.");
        return;
    }

    // Determine if we're in non-interactive mode
    const isNonInteractive = !!options.provider;

    // For each provider, check if it supports projects and prompt for project selection
    for (const providerName of selectedProviderNames) {
        const provider = availableProviders.find((p) => p.getName() === providerName);
        if (!provider) continue;

        // Check if provider supports projects
        const projects = await provider.getProjects();
        let projectChoices: Array<{ projectPath: string | null; displayName: string }> | null = null;

        if (projects.length > 0) {
            if (isNonInteractive) {
                // Non-interactive: apply globally to all projects
                projectChoices = [{ projectPath: null, displayName: "Global (all projects)" }];
            } else {
                // Interactive: prompt for selection
                projectChoices = await promptForProjects(
                    projects,
                    `Select projects for ${providerName} (or "Global" for all):`
                );

                if (!projectChoices || projectChoices.length === 0) {
                    logger.info(`No projects selected for ${providerName}.`);
                    continue;
                }
            }
        }

        // Collect servers to toggle
        const serversToToggle: string[] = [];
        for (const serverName of finalServerNames) {
            let serverConfig = config.mcpServers[serverName];

            // If enabling and server not in unified config, try to import it from provider first
            if (enabled && !serverConfig) {
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

            // If disabling, server must exist in unified config
            if (!enabled && !serverConfig) {
                logger.warn(
                    `Server '${serverName}' not found in unified config. Run 'tools mcp-manager config' to add it first.`
                );
                continue;
            }

            try {
                if (enabled) {
                    // Strip _meta before syncing to provider
                    const configToSync = stripMeta(serverConfig!);

                    // Check if server is installed globally in provider - if not, install it automatically
                    const existingServerConfig = await provider.getServerConfig(serverName);
                    if (!existingServerConfig) {
                        // Server not installed globally - install it first
                        logger.info(`Installing '${serverName}' globally in ${providerName}...`);
                        const installResult = await provider.installServer(serverName, configToSync);
                        if (installResult === WriteResult.Rejected) {
                            logger.warn(`Skipped '${serverName}' — user rejected installation in ${providerName}`);
                            continue;
                        }
                    }
                }

                serversToToggle.push(serverName);

                // Update _meta.enabled in unified config (source of truth)
                if (!config.mcpServers[serverName]._meta) {
                    config.mcpServers[serverName]._meta = { enabled: {} };
                }
                if (!config.mcpServers[serverName]._meta?.enabled) {
                    config.mcpServers[serverName]._meta!.enabled = {};
                }

                // Update enabled state based on project selection
                const enabledState = config.mcpServers[serverName]._meta?.enabled[providerName as MCPProviderName];

                // Determine if this is a global enablement (all projects) or per-project
                const isGlobalEnablement =
                    projectChoices && projectChoices.length === 1 && projectChoices[0].projectPath === null;

                if (projects.length > 0 && !isGlobalEnablement) {
                    // Provider supports projects and we have specific project selections - use project objects
                    const perProjectState: PerProjectEnabledState =
                        typeof enabledState === "object" && enabledState !== null && !Array.isArray(enabledState)
                            ? { ...(enabledState as PerProjectEnabledState) }
                            : {};

                    if (projectChoices && projectChoices.length > 0) {
                        // Set enabled/disabled for each selected project
                        for (const projectChoice of projectChoices) {
                            if (projectChoice.projectPath !== null) {
                                // Per-project enablement/disablement
                                perProjectState[projectChoice.projectPath] = enabled;
                            }
                        }
                    } else {
                        // No project choices but provider supports projects - set for all projects
                        for (const projectPath of projects) {
                            perProjectState[projectPath] = enabled;
                        }
                    }
                    config.mcpServers[serverName]._meta!.enabled[providerName as MCPProviderName] = perProjectState;
                } else if (isGlobalEnablement || projects.length === 0) {
                    // Global enablement (boolean true/false) - applies to all projects
                    config.mcpServers[serverName]._meta!.enabled[providerName as MCPProviderName] = enabled;
                } else {
                    // Provider doesn't support projects - use boolean
                    if (projectChoices && projectChoices.length > 0) {
                        // If project choices exist but provider doesn't support projects, use boolean
                        // (This shouldn't happen, but handle it gracefully)
                        config.mcpServers[serverName]._meta!.enabled[providerName as MCPProviderName] = enabled;
                    } else {
                        // No projects - global enablement/disablement (boolean)
                        config.mcpServers[serverName]._meta!.enabled[providerName as MCPProviderName] = enabled;
                    }
                }
            } catch (error: any) {
                logger.error(
                    `✗ Failed to prepare '${serverName}' for ${actionGerund} in ${providerName}: ${error.message}`
                );
            }
        }

        if (serversToToggle.length > 0) {
            const metaBackup = new Map<string, boolean | PerProjectEnabledState | undefined>();
            for (const serverName of serversToToggle) {
                const currentState = config.mcpServers[serverName]._meta?.enabled?.[providerName as MCPProviderName];
                if (typeof currentState === "object" && currentState !== null) {
                    metaBackup.set(serverName, { ...currentState } as PerProjectEnabledState);
                } else {
                    metaBackup.set(serverName, currentState);
                }
            }

            const restoreBackup = () => {
                for (const serverName of serversToToggle) {
                    const meta = config.mcpServers[serverName]._meta;
                    if (!meta) continue;
                    const backup = metaBackup.get(serverName);
                    if (backup === undefined) {
                        delete meta.enabled[providerName as MCPProviderName];
                    } else {
                        meta.enabled[providerName as MCPProviderName] = backup;
                    }
                }
            };

            try {
                if (projectChoices) {
                    for (const projectChoice of projectChoices) {
                        const result = enabled
                            ? await provider.enableServers(serversToToggle, projectChoice.projectPath)
                            : await provider.disableServers(serversToToggle, projectChoice.projectPath);

                        if (result === WriteResult.Rejected) {
                            restoreBackup();
                            logger.info(`Skipped ${providerName} - user rejected confirmation`);
                            continue;
                        }

                        if (result === WriteResult.Applied) {
                            if (projectChoice.projectPath === null) {
                                logger.info(
                                    `✓ ${actionPast.charAt(0).toUpperCase() + actionPast.slice(1)} ${
                                        serversToToggle.length
                                    } server(s) globally in ${providerName}`
                                );
                            } else {
                                logger.info(
                                    `✓ ${actionPast.charAt(0).toUpperCase() + actionPast.slice(1)} ${
                                        serversToToggle.length
                                    } server(s) in ${providerName} for project: ${projectChoice.displayName}`
                                );
                            }
                        } else if (result === WriteResult.NoChanges) {
                            logger.info(
                                `→ ${serversToToggle.length} server(s) already ${actionPast} in ${providerName} — no changes needed`
                            );
                        }
                    }
                } else {
                    const result = enabled
                        ? await provider.enableServers(serversToToggle)
                        : await provider.disableServers(serversToToggle);

                    if (result === WriteResult.Rejected) {
                        restoreBackup();
                        logger.info(`Skipped ${providerName} - user rejected confirmation`);
                        continue;
                    }

                    if (result === WriteResult.Applied) {
                        logger.info(
                            `✓ ${actionPast.charAt(0).toUpperCase() + actionPast.slice(1)} ${
                                serversToToggle.length
                            } server(s) globally in ${providerName}`
                        );
                    } else if (result === WriteResult.NoChanges) {
                        logger.info(
                            `→ ${serversToToggle.length} server(s) already ${actionPast} in ${providerName} — no changes needed`
                        );
                    }
                }
            } catch (error: any) {
                logger.error(`✗ Failed to ${action} servers in ${providerName}: ${error.message}`);
            }
        }
    }

    // Write updated config with _meta changes
    await writeUnifiedConfig(config);
}
