import { logger } from "@app/logger";
import { getServerNames } from "@app/mcp-manager/utils/command.utils.js";
import { readUnifiedConfig, writeUnifiedConfig } from "@app/mcp-manager/utils/config.utils.js";
import type { MCPProvider } from "@app/mcp-manager/utils/providers/types.js";
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
    for (const provider of providers) {
        const providerName = provider.getName();
        try {
            if (!(await provider.configExists())) {
                continue;
            }

            const result = await provider.removeServers(serverNames);
            if (result === WriteResult.Applied) {
                logger.info(`✓ Removed from ${providerName}`);
            } else if (result === WriteResult.Rejected) {
                logger.info(`Skipped ${providerName} - user rejected confirmation`);
            } else {
                logger.info(`→ Nothing to remove in ${providerName}`);
            }
        } catch (error) {
            logger.error(
                `✗ Failed to remove from ${providerName}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    // 2. Remove from the unified config (mcpServers + enabledMcpServers mirror;
    //    writeUnifiedConfig also rebuilds the mirror from the remaining _meta)
    for (const serverName of serverNames) {
        delete config.mcpServers[serverName];
        if (config.enabledMcpServers?.[serverName]) {
            delete config.enabledMcpServers[serverName];
        }
    }

    const written = await writeUnifiedConfig(config);
    if (written) {
        logger.info(chalk.green(`✓ Removed ${serverNames.length} server(s) from unified config`));
    }
}
