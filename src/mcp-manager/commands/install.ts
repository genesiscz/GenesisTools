import Enquirer from "enquirer";
import logger from "@app/logger";
import type { UnifiedMCPServerConfig, MCPProvider } from "../utils/providers/types.js";
import { readUnifiedConfig, writeUnifiedConfig, stripMeta } from "../utils/config.utils.js";
import { parseCommandString, parseEnvString } from "../utils/command.utils.js";

const prompter = new Enquirer();

/**
 * Install/add an MCP server configuration
 */
export async function installServer(
    serverName: string | undefined,
    commandString: string | undefined,
    providers: MCPProvider[]
): Promise<void> {
    const config = await readUnifiedConfig();
    let finalServerName = serverName;
    let serverConfig: UnifiedMCPServerConfig | undefined;

    // Scenario 1: No server name provided - prompt for it with autocomplete
    if (!finalServerName) {
        try {
            const existingServers = Object.keys(config.mcpServers);
            const { inputServerName } = (await prompter.prompt({
                type: "autocomplete",
                name: "inputServerName",
                message: "Enter server name (type new name or select existing):",
                choices: existingServers.length > 0 ? existingServers : [""],
                limit: 30,
                scroll: false,
            } as any)) as { inputServerName: string };

            finalServerName = inputServerName.trim();

            if (!finalServerName) {
                logger.warn("Server name cannot be empty.");
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

    // Check if server exists in unified config
    serverConfig = config.mcpServers[finalServerName];

    // Scenario 2 & 3: Server doesn't exist OR command string provided - collect server info
    if (!serverConfig || commandString) {
        let finalCommandString = commandString;

        // Scenario 3: No command provided - prompt for it
        if (!finalCommandString) {
            try {
                const { inputCommand } = (await prompter.prompt({
                    type: "input",
                    name: "inputCommand",
                    message: 'Enter command (e.g., "npx -y @modelcontextprotocol/server-github"):',
                })) as { inputCommand: string };

                finalCommandString = inputCommand.trim();

                if (!finalCommandString) {
                    logger.warn("Command cannot be empty.");
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

        // Parse command string
        let command: string;
        let args: string[];

        try {
            const parsed = parseCommandString(finalCommandString);
            command = parsed.command;
            args = parsed.args;
        } catch (error: any) {
            logger.error(`Failed to parse command: ${error.message}`);
            return;
        }

        // Always ask for ENV variables
        let env: Record<string, string> = {};
        try {
            const { inputEnv } = (await prompter.prompt({
                type: "input",
                name: "inputEnv",
                message: "Enter ENV variables (format: KEY1=value1 KEY2=value2) or leave empty:",
            })) as { inputEnv: string };

            if (inputEnv.trim()) {
                env = parseEnvString(inputEnv.trim());
                logger.info(`Parsed ${Object.keys(env).length} environment variable(s)`);
            }
        } catch (error: any) {
            if (error.message === "canceled") {
                logger.info("\nOperation cancelled by user.");
                return;
            }
            throw error;
        }

        // Create the server config
        serverConfig = {
            command,
            args,
            ...(Object.keys(env).length > 0 && { env }),
        };

        // Update unified config with new server
        config.mcpServers[finalServerName] = serverConfig;
        await writeUnifiedConfig(config);
        logger.info(`✓ Created/updated server '${finalServerName}' in unified config`);
    }

    // Install to provider
    const availableProviders = providers.filter((p) => p.configExists());

    if (availableProviders.length === 0) {
        logger.warn("No provider configuration files found.");
        return;
    }

    try {
        const { selectedProvider } = (await prompter.prompt({
            type: "select",
            name: "selectedProvider",
            message: "Select provider to install to:",
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProvider: string };

        const provider = availableProviders.find((p) => p.getName() === selectedProvider);
        if (!provider) return;

        // Strip _meta before installing to provider (unified utility ensures _meta never reaches providers)
        const configToInstall = stripMeta(serverConfig);
        await provider.installServer(finalServerName, configToInstall);
        logger.info(`✓ Installed '${finalServerName}' to ${selectedProvider}`);
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return;
        }
        throw error;
    }
}
