import logger, { consoleLog } from "@app/logger";
import type { MCPProvider, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import chalk from "chalk";

/**
 * Show the full configuration of an MCP server
 */
export async function showServerConfig(serverName: string, providers: MCPProvider[]): Promise<void> {
    const configs: Array<{ provider: string; config: UnifiedMCPServerConfig | null }> = [];

    for (const provider of providers) {
        if (await provider.configExists()) {
            const config = await provider.getServerConfig(serverName);
            if (config) {
                configs.push({ provider: provider.getName(), config });
            }
        }
    }

    if (configs.length === 0) {
        logger.warn(`Server '${serverName}' not found in any provider.`);
        return;
    }

    consoleLog.info(`\nConfiguration for '${serverName}':\n`);
    for (const { provider, config } of configs) {
        consoleLog.info(`${chalk.bold(provider)}:`);
        consoleLog.info(JSON.stringify(config, null, 2));
        consoleLog.info("");
    }
}
