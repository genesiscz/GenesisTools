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
    let providersNotRemoved = 0;

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
