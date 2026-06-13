import { logger } from "@app/logger";
import { getServerNames } from "@app/mcp-manager/utils/command.utils.js";
import { readUnifiedConfig, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { MCPProvider, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { WriteResult } from "@app/mcp-manager/utils/providers/types.js";
import chalk from "chalk";

export interface RemoveOptions {
    provider?: string; // Provider name(s) for non-interactive mode (already pre-filtered by parseProviderArg)
}

/**
 * Completely REMOVE server(s):
 * - from every selected provider's config (claude mcpServers incl.
 *   project-scope entries, cursor mcpServers, gemini mcpServers +
 *   mcp.excluded, codex [mcp_servers.<name>] incl. nested subsections),
 * - from the unified config (`mcpServers.<name>` and the
 *   `enabledMcpServers.<name>` mirror).
 *
 * Unlike `disable`, this is PERMANENT — the server config is no longer kept
 * anywhere, so it cannot be restored by `enable` or `sync`.
 */
export async function removeServers(
    serverNamesArg: string | undefined,
    providers: MCPProvider[],
    _options: RemoveOptions = {}
): Promise<void> {
    const config = await readUnifiedConfig();

    if (Object.keys(config.mcpServers).length === 0) {
        logger.warn("No servers found in unified config. Run 'tools mcp-manager config' to add servers.");
        return;
    }

    const serverNames = await getServerNames(serverNamesArg, config, "Select servers to REMOVE (permanent):");
    if (!serverNames || serverNames.length === 0) {
        logger.info("No servers selected.");
        return;
    }

    logger.info(
        chalk.yellow(
            `Removing ${serverNames.length} server(s) PERMANENTLY: ${serverNames.join(", ")}\n` +
                `  (hint: 'tools mcp-manager disable' is the reversible alternative — it keeps the config in the unified config)`
        )
    );

    // 1. Remove from every selected provider that has a config file
    let providersNotRemoved = 0;
    const providersSuccess = new Map<string, UnifiedMCPServerConfig[]>();

    for (const provider of providers) {
        const providerName = provider.getName();
        try {
            if (!(await provider.configExists())) {
                continue;
            }

            const result = await provider.removeServers(serverNames);
            if (result === WriteResult.Applied) {
                logger.info(`✓ Removed from ${providerName}`);
                // Track successful removal with configs for potential rollback
                const removedConfigs: UnifiedMCPServerConfig[] = [];
                for (const serverName of serverNames) {
                    const serverConfig = config.mcpServers[serverName];
                    if (serverConfig) {
                        removedConfigs.push(serverConfig);
                    }
                }
                providersSuccess.set(providerName, removedConfigs);
            } else if (result === WriteResult.Rejected) {
                providersNotRemoved++;
                logger.info(`Skipped ${providerName} - user rejected confirmation`);
            } else {
                logger.info(`→ Nothing to remove in ${providerName}`);
            }
        } catch (error) {
            providersNotRemoved++;
            logger.error({ providerName, error }, `✗ Failed to remove from ${providerName}`);
        }
    }

    // Keep the unified entries while any provider still holds the server —
    // deleting them here would orphan the provider config (no unified record
    // to retry/disable against) and break the "remove everywhere" contract.
    if (providersNotRemoved > 0) {
        logger.warn(
            chalk.yellow(
                `Keeping ${serverNames.length} server(s) in the unified config — ` +
                    `${providersNotRemoved} provider(s) failed or were rejected. Re-run remove to retry.`
            )
        );
        return;
    }

    // 2. Remove from the unified config (mcpServers + enabledMcpServers mirror;
    //    writeUnifiedConfig also rebuilds the mirror from the remaining _meta)
    const originalConfigs = new Map<string, UnifiedMCPServerConfig>();
    for (const serverName of serverNames) {
        originalConfigs.set(serverName, config.mcpServers[serverName]);
        delete config.mcpServers[serverName];
        if (config.enabledMcpServers?.[serverName]) {
            delete config.enabledMcpServers[serverName];
        }
    }

    let written: boolean;
    try {
        written = await writeUnifiedConfig(config);
    } catch (error) {
        logger.error({ error }, "Failed to write unified config - rolling back provider changes");
        written = false;
    }

    if (!written) {
        // Rollback: restore servers to providers that successfully removed them
        logger.warn(chalk.yellow("Rolling back provider changes..."));
        for (const [providerName, removedConfigs] of providersSuccess.entries()) {
            const provider = providers.find((p) => p.getName() === providerName);
            if (!provider) {
                continue;
            }
            try {
                for (let i = 0; i < serverNames.length; i++) {
                    const serverName = serverNames[i];
                    const serverConfig = removedConfigs[i];
                    if (serverConfig) {
                        await provider.installServer(serverName, serverConfig);
                    }
                }
                logger.info(`✓ Rolled back ${providerName}`);
            } catch (error) {
                providersNotRemoved++;
                logger.error({ providerName, error }, `✗ Failed to rollback ${providerName}`);
            }
        }
        logger.error(chalk.red("Failed to remove servers from unified config - all changes rolled back"));
        return;
    }

    logger.info(chalk.green(`✓ Removed ${serverNames.length} server(s) from unified config`));
}
