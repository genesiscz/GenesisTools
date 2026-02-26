import logger from "@app/logger";
import type { MCPProvider, MCPServerInfo } from "@app/mcp-manager/utils/providers/types.js";
import chalk from "chalk";

/**
 * List all MCP servers across all providers
 */
export async function listServers(providers: MCPProvider[]): Promise<void> {
    const allServers: MCPServerInfo[] = [];

    for (const provider of providers) {
        try {
            if (await provider.configExists()) {
                const servers = await provider.listServers();
                allServers.push(...servers);
            }
        } catch (error) {
            logger.warn(
                `Failed to read ${provider.getName()} config: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    if (allServers.length === 0) {
        logger.info("No MCP servers found.");
        return;
    }

    // Group by server name
    const serversByName = new Map<string, MCPServerInfo[]>();
    for (const server of allServers) {
        if (!serversByName.has(server.name)) {
            serversByName.set(server.name, []);
        }
        serversByName.get(server.name)?.push(server);
    }

    // Display
    logger.info("\nMCP Servers:\n");
    for (const [name, instances] of serversByName.entries()) {
        const enabledCount = instances.filter((s) => s.enabled).length;
        const status = enabledCount === instances.length ? "✓" : enabledCount > 0 ? "⚠" : "✗";
        const statusText = enabledCount === instances.length ? "enabled" : enabledCount > 0 ? "partial" : "disabled";

        logger.info(`${status} ${chalk.bold(name)} (${statusText} in ${instances.length} provider(s))`);
        for (const instance of instances) {
            const providerStatus = instance.enabled ? chalk.green("enabled") : chalk.red("disabled");
            logger.info(`  └─ ${instance.provider}: ${providerStatus}`);
        }
        logger.info("");
    }
}
