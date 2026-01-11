import Enquirer from "enquirer";
import chalk from "chalk";
import logger from "@app/logger";
import type { MCPProvider, UnifiedMCPServerConfig } from "../utils/providers/types.js";
import type { MCPProviderName, PerProjectEnabledState, ProviderEnabledState } from "../utils/types.js";
import { readUnifiedConfig, writeUnifiedConfig } from "../utils/config.utils.js";
import { DiffUtil } from "@app/utils/diff";

const prompter = new Enquirer();

/**
 * Sync servers FROM providers TO unified config
 */
export async function syncFromProviders(providers: MCPProvider[]): Promise<void> {
    const availableProviders: MCPProvider[] = [];

    // Check which providers have configs
    for (const provider of providers) {
        if (await provider.configExists()) {
            availableProviders.push(provider);
        }
    }

    if (availableProviders.length === 0) {
        logger.warn("No provider configuration files found.");
        return;
    }

    try {
        const { selectedProviders } = (await prompter.prompt({
            type: "multiselect",
            name: "selectedProviders",
            message: "Select providers to sync from:",
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProviders: string[] };

        if (selectedProviders.length === 0) {
            logger.info("No providers selected. Cancelled.");
            return;
        }

        // Read current unified config
        const unifiedConfig = await readUnifiedConfig();
        // Preserve _meta from existing config when merging
        const mergedServers: Record<string, UnifiedMCPServerConfig> = {};
        for (const [name, config] of Object.entries(unifiedConfig.mcpServers)) {
            mergedServers[name] = { ...config };
        }

        // Track conflicts: serverName -> { existing: config, incoming: config, provider: string }
        const conflicts: Map<
            string,
            {
                existing: UnifiedMCPServerConfig;
                incoming: UnifiedMCPServerConfig;
                provider: string;
            }
        > = new Map();

        // Import servers from each selected provider
        for (const providerName of selectedProviders) {
            const provider = availableProviders.find((p) => p.getName() === providerName);
            if (!provider) continue;

            try {
                logger.info(`Reading servers from ${providerName}...`);

                // Check if provider supports projects
                const projects = await provider.getProjects();
                const providerSupportsProjects = projects.length > 0;

                // Use listServers to get enabled state information
                const serverInfos = await provider.listServers();
                const providerServers: Record<string, UnifiedMCPServerConfig> = {};
                // Track enabled state: boolean for global, or PerProjectEnabledState for per-project
                const serverEnabledStates: Map<string, ProviderEnabledState> = new Map();
                const serverProjectStates: Map<string, Map<string, boolean>> = new Map();

                // Build server configs and track enabled states
                // Process all servers from this provider (both global and project-specific)
                for (const serverInfo of serverInfos) {
                    // Only process servers from this provider
                    if (serverInfo.provider === providerName || serverInfo.provider.startsWith(`${providerName}:`)) {
                        // Use the first config we encounter (prefer global over project-specific)
                        if (!providerServers[serverInfo.name]) {
                            providerServers[serverInfo.name] = serverInfo.config;
                        }

                        // Track enabled state per project
                        if (serverInfo.provider.startsWith(`${providerName}:`)) {
                            // Project-specific server
                            const projectPath = serverInfo.provider.substring(providerName.length + 1);
                            if (!serverProjectStates.has(serverInfo.name)) {
                                serverProjectStates.set(serverInfo.name, new Map());
                            }
                            serverProjectStates.get(serverInfo.name)!.set(projectPath, serverInfo.enabled);
                        } else {
                            // Global server
                            const currentState = serverEnabledStates.get(serverInfo.name);
                            if (typeof currentState === "boolean") {
                                // Already set as boolean, keep true if enabled anywhere
                                serverEnabledStates.set(serverInfo.name, currentState || serverInfo.enabled);
                            } else {
                                // Not set or is per-project object, set as boolean
                                serverEnabledStates.set(serverInfo.name, serverInfo.enabled);
                            }
                        }
                    }
                }

                // For providers with projects, get complete per-project enabled states
                if (providerSupportsProjects) {
                    const perProjectStates = await provider.getServerEnabledStatesPerProject();

                    // Merge per-project states into our tracking map
                    for (const [serverName, projectStates] of perProjectStates.entries()) {
                        // Ensure server config exists (might be global server not in listServers)
                        if (!providerServers[serverName]) {
                            const serverConfig = await provider.getServerConfig(serverName);
                            if (serverConfig) {
                                providerServers[serverName] = serverConfig;
                            }
                        }

                        // Initialize project states map if not exists
                        if (!serverProjectStates.has(serverName)) {
                            serverProjectStates.set(serverName, new Map());
                        }

                        // Add all per-project states
                        for (const [projectPath, enabled] of Object.entries(projectStates)) {
                            serverProjectStates.get(serverName)!.set(projectPath, enabled);
                        }
                    }
                }

                // Check for conflicts before merging
                for (const [serverName, serverConfig] of Object.entries(providerServers)) {
                    const existingConfig = mergedServers[serverName];

                    // Determine enabled state: per-project if provider supports projects, otherwise boolean
                    let enabledState: ProviderEnabledState;
                    const projectStates = serverProjectStates.get(serverName);
                    if (providerSupportsProjects && projectStates && projectStates.size > 0) {
                        // Per-project enablement - use project object
                        const perProjectState: PerProjectEnabledState = {};
                        for (const [projectPath, enabled] of projectStates.entries()) {
                            perProjectState[projectPath] = enabled;
                        }
                        enabledState = perProjectState;
                    } else {
                        // Global enablement (boolean) or no projects
                        enabledState = serverEnabledStates.get(serverName) ?? false;
                    }

                    if (existingConfig) {
                        // Preserve _meta from existing config
                        const preservedMeta = existingConfig._meta || { enabled: {} };

                        // Update enabled state for this provider
                        if (!preservedMeta.enabled) {
                            preservedMeta.enabled = {};
                        }
                        preservedMeta.enabled[providerName as MCPProviderName] = enabledState;

                        // Check if there's a conflict in args, env, or other critical fields
                        const conflictCheck = DiffUtil.detectConflicts(
                            existingConfig as Record<string, unknown>,
                            serverConfig as Record<string, unknown>,
                            ["command", "args", "env", "url", "type"]
                        );

                        if (conflictCheck.hasConflict) {
                            // Store conflict for later resolution (preserve _meta with enabled state)
                            conflicts.set(serverName, {
                                existing: existingConfig,
                                incoming: { ...serverConfig, _meta: preservedMeta },
                                provider: providerName,
                            });
                            logger.warn(
                                chalk.yellow(
                                    `⚠ Conflict detected for '${serverName}': differences in ${conflictCheck.differences.join(
                                        ", "
                                    )}`
                                )
                            );
                        } else {
                            // No conflict, safe to merge (preserve _meta with enabled state)
                            mergedServers[serverName] = { ...serverConfig, _meta: preservedMeta };
                            const enabledDisplay =
                                typeof enabledState === "boolean"
                                    ? enabledState.toString()
                                    : `${Object.keys(enabledState).length} project(s)`;
                            logger.debug(`  Imported: ${serverName} (enabled: ${enabledDisplay})`);
                        }
                    } else {
                        // New server, no conflict - set _meta with enabled state
                        mergedServers[serverName] = {
                            ...serverConfig,
                            _meta: {
                                enabled: {
                                    [providerName]: enabledState,
                                },
                            },
                        };
                        const enabledDisplay =
                            typeof enabledState === "boolean"
                                ? enabledState.toString()
                                : `${Object.keys(enabledState).length} project(s)`;
                        logger.debug(`  Imported: ${serverName} (enabled: ${enabledDisplay})`);
                    }
                }

                logger.info(`✓ Imported ${Object.keys(providerServers).length} server(s) from ${providerName}`);
            } catch (error: any) {
                logger.error(`✗ Failed to read from ${providerName}: ${error.message}`);
            }
        }

        // Resolve conflicts if any
        if (conflicts.size > 0) {
            logger.info(chalk.yellow(`\n⚠ Found ${conflicts.size} conflict(s) that need resolution:\n`));

            for (const [serverName, conflict] of conflicts.entries()) {
                logger.info(chalk.bold(`\nConflict for server: ${chalk.cyan(serverName)}`));
                logger.info(`Provider: ${chalk.magenta(conflict.provider)}\n`);

                // Show diff
                const existingJson = JSON.stringify(conflict.existing, null, 2);
                const incomingJson = JSON.stringify(conflict.incoming, null, 2);

                await DiffUtil.showDiff(
                    existingJson,
                    incomingJson,
                    "Current (unified config)",
                    `Incoming (${conflict.provider})`
                );

                // Ask user to choose
                try {
                    const { choice } = (await prompter.prompt({
                        type: "select",
                        name: "choice",
                        message: `Which version should be kept for '${serverName}'?`,
                        choices: [
                            {
                                name: "current",
                                message: `Keep current (unified config)`,
                            },
                            {
                                name: "incoming",
                                message: `Use incoming (${conflict.provider})`,
                            },
                        ],
                    })) as { choice: string };

                    if (choice === "incoming") {
                        // Merge _meta.enabled from both versions when using incoming version
                        const existingMeta = mergedServers[serverName]?._meta;
                        const incomingMeta = conflict.incoming._meta;
                        const mergedMeta = {
                            enabled: {
                                ...existingMeta?.enabled,
                                ...incomingMeta?.enabled,
                            },
                        };
                        mergedServers[serverName] = { ...conflict.incoming, _meta: mergedMeta };
                        logger.info(chalk.green(`✓ Using incoming version from ${conflict.provider}`));
                    } else {
                        // Merge enabled state from incoming into existing
                        const existingMeta = mergedServers[serverName]?._meta || { enabled: {} };
                        const incomingMeta = conflict.incoming._meta;
                        if (incomingMeta?.enabled) {
                            existingMeta.enabled = {
                                ...existingMeta.enabled,
                                ...incomingMeta.enabled,
                            };
                        }
                        mergedServers[serverName] = { ...mergedServers[serverName], _meta: existingMeta };
                        logger.info(chalk.green(`✓ Keeping current version (merged enabled state)`));
                    }
                } catch (error: any) {
                    if (error.message === "canceled") {
                        logger.info("\nOperation cancelled by user.");
                        return;
                    }
                    throw error;
                }
            }
        }

        // Update unified config with merged servers
        unifiedConfig.mcpServers = mergedServers;
        // Sync enabledMcpServers with _meta.enabled before writing
        await writeUnifiedConfig(unifiedConfig);

        logger.info(
            chalk.green(`✓ Successfully synced ${Object.keys(mergedServers).length} server(s) to unified config`)
        );
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return;
        }
        throw error;
    }
}
