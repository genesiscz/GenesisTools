import { readUnifiedConfigReadOnly } from "@app/mcp-manager/utils/config.utils.js";
import type { MCPProvider, UnifiedMCPServerConfig } from "@app/mcp-manager/utils/providers/types.js";
import { isInteractive } from "@genesiscz/utils/cli";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import chalk from "chalk";
import { redactMcpValue } from "../lib/auth/redact.ts";

/**
 * Show the full configuration of an MCP server. With no name: a TTY picks from
 * the unified config's server list, a non-TTY prints usage and exits non-zero
 * (#447 section E — it used to look up a server literally named "" and exit 0).
 */
export async function showServerConfig(serverName: string | undefined, providers: MCPProvider[]): Promise<void> {
    let finalServerName = serverName;

    if (!finalServerName) {
        if (!isInteractive()) {
            logger.error("Server name required.");
            logger.info("Usage: tools mcp-manager show <server>");
            process.exitCode = 1;
            return;
        }

        const config = await readUnifiedConfigReadOnly();
        const serverNames = Object.keys(config.mcpServers).sort();

        if (serverNames.length === 0) {
            logger.warn("No servers found in unified config.");
            process.exitCode = 1;
            return;
        }

        const selected = await p.search<string>({
            message: "Select server to show:",
            options: async (term) => {
                const filtered = !term
                    ? serverNames
                    : serverNames.filter((name) => name.toLowerCase().includes(term.toLowerCase()));
                return filtered.map((name) => ({ value: name, label: name }));
            },
            pageSize: 30,
        });

        finalServerName = selected.trim();
    }

    const configs: Array<{ provider: string; config: UnifiedMCPServerConfig | null }> = [];

    for (const provider of providers) {
        if (await provider.configExists()) {
            const config = await provider.getServerConfig(finalServerName);
            if (config) {
                configs.push({ provider: provider.getName(), config });
            }
        }
    }

    if (configs.length === 0) {
        logger.warn(`Server '${finalServerName}' not found in any provider.`);
        return;
    }

    // `mcp-manager show <server>` — the config dump is the command's
    // machine result, so it goes to stdout via out.print (Task-17's
    // mechanical consoleLog→logger rename had mis-routed it to stderr).
    out.println(`\nConfiguration for '${finalServerName}':\n`);
    for (const { provider, config } of configs) {
        out.println(`${chalk.bold(provider)}:`);
        out.println(SafeJSON.stringify(redactMcpValue(config), null, 2));
        out.println("");
    }
}
