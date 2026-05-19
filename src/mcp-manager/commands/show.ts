import { logger, out } from "@app/logger";
import type { MCPProvider, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { SafeJSON } from "@app/utils/json";
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

    // `mcp-manager show <server>` — the config dump is the command's
    // machine result, so it goes to stdout via out.print (Task-17's
    // mechanical consoleLog→logger rename had mis-routed it to stderr).
    out.print(`\nConfiguration for '${serverName}':\n`);
    for (const { provider, config } of configs) {
        out.print(`${chalk.bold(provider)}:`);
        out.print(SafeJSON.stringify(config, null, 2));
        out.print("");
    }
}
