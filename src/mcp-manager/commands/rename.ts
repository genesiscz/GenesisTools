import Enquirer from "enquirer";
import logger from "@app/logger";
import chalk from "chalk";
import type { MCPProvider } from "../utils/providers/types.js";
import { readUnifiedConfig, writeUnifiedConfig } from "../utils/config.utils.js";
import { DiffUtil } from "@app/utils/diff";

const prompter = new Enquirer();

/**
 * Rename an MCP server key across unified config and all providers
 */
export async function renameServer(
    oldName: string | undefined,
    newName: string | undefined,
    providers: MCPProvider[]
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
            const { selectedOldName } = (await prompter.prompt({
                type: "autocomplete",
                name: "selectedOldName",
                message: "Select server to rename:",
                choices: serverNames,
                limit: 30,
                scroll: false,
            } as any)) as { selectedOldName: string };

            finalOldName = selectedOldName.trim();
        } catch (error: any) {
            if (error.message === "canceled") {
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
            const { inputNewName } = (await prompter.prompt({
                type: "input",
                name: "inputNewName",
                message: `Enter new name for '${finalOldName}':`,
                initial: finalOldName,
            })) as { inputNewName: string };

            finalNewName = inputNewName.trim();
        } catch (error: any) {
            if (error.message === "canceled") {
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
            `'${finalOldName}' (will replace)`
        );

        try {
            const { confirmed } = (await prompter.prompt({
                type: "confirm",
                name: "confirmed",
                message: `Replace existing server '${finalNewName}' with '${finalOldName}'?`,
                initial: false,
            })) as { confirmed: boolean };

            if (!confirmed) {
                logger.info("Rename cancelled by user.");
                return;
            }
        } catch (error: any) {
            if (error.message === "canceled") {
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
    await writeUnifiedConfig(config);
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
        const { selectedProviders } = (await prompter.prompt({
            type: "multiselect",
            name: "selectedProviders",
            message: "Select providers to sync rename to:",
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProviders: string[] };

        selectedProviderNames = selectedProviders;
    } catch (error: any) {
        if (error.message === "canceled") {
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
        if (!provider) continue;

        try {
            await renameServerInProvider(provider, finalOldName, finalNewName, serverConfig);
            logger.info(`✓ Renamed '${finalOldName}' to '${finalNewName}' in ${providerName}`);
        } catch (error: any) {
            logger.error(`✗ Failed to rename in ${providerName}: ${error.message}`);
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
    serverConfig: any
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
            `'${oldName}' (will replace)`
        );

        try {
            const { confirmed } = (await prompter.prompt({
                type: "confirm",
                name: "confirmed",
                message: `Replace existing server '${newName}' in ${provider.getName()}?`,
                initial: false,
            })) as { confirmed: boolean };

            if (!confirmed) {
                logger.info(`Skipping rename in ${provider.getName()}.`);
                return;
            }
        } catch (error: any) {
            if (error.message === "canceled") {
                logger.info(`\nSkipping rename in ${provider.getName()}.`);
                return;
            }
            throw error;
        }
    }

    // Prepare unified servers map with renamed server
    // Start with current unified servers (keep _meta intact for enabled state)
    const serversToSync: Record<string, any> = { ...unifiedServers };

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
    await provider.syncServers(serversToSync);

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
            const claudeConfig = config as any;
            // Remove from global mcpServers
            if (claudeConfig.mcpServers?.[serverName]) {
                delete claudeConfig.mcpServers[serverName];
            }
            // Remove from disabledMcpServers array
            if (claudeConfig.disabledMcpServers) {
                claudeConfig.disabledMcpServers = claudeConfig.disabledMcpServers.filter(
                    (name: string) => name !== serverName
                );
            }
            // Remove from project-specific configs
            if (claudeConfig.projects) {
                for (const projectConfig of Object.values(claudeConfig.projects) as any[]) {
                    if (projectConfig.mcpServers?.[serverName]) {
                        delete projectConfig.mcpServers[serverName];
                    }
                    if (projectConfig.disabledMcpServers) {
                        projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter(
                            (name: string) => name !== serverName
                        );
                    }
                }
            }
            await provider.writeConfig(claudeConfig);
            break;
        }
        case "codex": {
            const codexConfig = config as any;
            if (codexConfig.mcp_servers?.[serverName]) {
                delete codexConfig.mcp_servers[serverName];
            }
            await provider.writeConfig(codexConfig);
            break;
        }
        case "cursor": {
            const cursorConfig = config as any;
            if (cursorConfig.mcpServers?.[serverName]) {
                delete cursorConfig.mcpServers[serverName];
            }
            await provider.writeConfig(cursorConfig);
            break;
        }
        case "gemini": {
            const geminiConfig = config as any;
            // Remove from mcpServers
            if (geminiConfig.mcpServers?.[serverName]) {
                delete geminiConfig.mcpServers[serverName];
            }
            // Remove from excluded list
            if (geminiConfig.mcp?.excluded) {
                geminiConfig.mcp.excluded = geminiConfig.mcp.excluded.filter((name: string) => name !== serverName);
            }
            await provider.writeConfig(geminiConfig);
            break;
        }
        default:
            logger.warn(`Unknown provider: ${providerName}. Cannot remove server.`);
    }
}
