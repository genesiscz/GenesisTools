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
    commandOrUrl: string | undefined,
    providers: MCPProvider[],
    options?: { type?: string }
): Promise<void> {
    const config = await readUnifiedConfig();
    let finalServerName = serverName;
    let serverConfig: UnifiedMCPServerConfig | undefined;

    // Create new server constant
    const CREATE_NEW = "__create_new__";

    // Scenario 1: No server name provided - prompt for it with autocomplete
    if (!finalServerName) {
        try {
            const existingServers = Object.keys(config.mcpServers).sort();
            const choices = [
                { name: CREATE_NEW, message: chalk.cyan("+ Create new server...") },
                ...existingServers.map((name) => ({ name, message: name })),
            ];

            const { inputServerName } = (await prompter.prompt({
                type: "autocomplete",
                name: "inputServerName",
                message: "Select server to install or create new:",
                choices,
                limit: 30,
                scroll: false,
            } as any)) as { inputServerName: string };

            if (inputServerName === CREATE_NEW) {
                const { newServerName } = (await prompter.prompt({
                    type: "input",
                    name: "newServerName",
                    message: "Enter name for the new server:",
                    validate: (value: string) => (value.trim() ? true : "Server name cannot be empty."),
                })) as { newServerName: string };
                finalServerName = newServerName.trim();
            } else {
                finalServerName = inputServerName.trim();
            }

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

    // Scenario 2 & 3: Server doesn't exist OR command/url provided - collect server info
    if (!serverConfig || commandOrUrl || options?.type) {
        let transportType = options?.type as "stdio" | "sse" | "http" | undefined;

        // If it's a new server or we're overwriting, ask for details
        if (!transportType) {
            try {
                const { inputType } = (await prompter.prompt({
                    type: "select",
                    name: "inputType",
                    message: "Select transport type:",
                    choices: [
                        { name: "stdio", message: "stdio (Local executable/npx)" },
                        { name: "sse", message: "sse (Server-Sent Events / Remote URL)" },
                        { name: "http", message: "http (Remote HTTP endpoint)" },
                    ],
                    initial: serverConfig?.type || "stdio",
                })) as { inputType: string };
                transportType = inputType as any;
            } catch (error: any) {
                if (error.message === "canceled") {
                    logger.info("\nOperation cancelled by user.");
                    return;
                }
                throw error;
            }
        }

        let finalCommandOrUrl = commandOrUrl;

        // Prompt for command or URL based on type
        if (!finalCommandOrUrl) {
            try {
                const isRemote = transportType === "sse" || transportType === "http";
                const { inputVal } = (await prompter.prompt({
                    type: "input",
                    name: "inputVal",
                    message: isRemote
                        ? `Enter URL (e.g., "https://server.example.com/sse"):`
                        : 'Enter command (e.g., "npx -y @modelcontextprotocol/server-github"):',
                    initial: isRemote ? serverConfig?.url || serverConfig?.httpUrl : serverConfig?.command,
                })) as { inputVal: string };

                finalCommandOrUrl = inputVal.trim();

                if (!finalCommandOrUrl) {
                    logger.warn("Value cannot be empty.");
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

        // Build new server config
        const newServerConfig: UnifiedMCPServerConfig = {
            type: transportType,
        };

        if (transportType === "sse" || transportType === "http") {
            newServerConfig.url = finalCommandOrUrl;
            if (transportType === "http") {
                newServerConfig.httpUrl = finalCommandOrUrl;
            }

            // Optionally ask for headers
            try {
                const { inputHeaders } = (await prompter.prompt({
                    type: "input",
                    name: "inputHeaders",
                    message: "Enter optional headers (JSON format or KEY=value KEY2=value) or leave empty:",
                    initial: serverConfig?.headers ? JSON.stringify(serverConfig.headers) : "",
                })) as { inputHeaders: string };

                if (inputHeaders.trim()) {
                    if (inputHeaders.trim().startsWith("{")) {
                        newServerConfig.headers = JSON.parse(inputHeaders.trim());
                    } else {
                        newServerConfig.headers = parseEnvString(inputHeaders.trim());
                    }
                }
            } catch (error: any) {
                if (error.message === "canceled") {
                    logger.info("\nOperation cancelled by user.");
                    return;
                }
                logger.warn(`Failed to parse headers: ${error.message}. Skipping headers.`);
            }
        } else {
            // stdio
            try {
                const parsed = parseCommandString(finalCommandOrUrl);
                newServerConfig.command = parsed.command;
                newServerConfig.args = parsed.args;
            } catch (error: any) {
                logger.error(`Failed to parse command: ${error.message}`);
                return;
            }

            // Ask for ENV variables
            let env: Record<string, string> = serverConfig?.env || {};
            try {
                const { inputEnv } = (await prompter.prompt({
                    type: "input",
                    name: "inputEnv",
                    message: "Enter ENV variables (format: KEY1=value1 KEY2=value2) or leave empty:",
                    initial: serverConfig?.env
                        ? Object.entries(serverConfig.env)
                              .map(([k, v]) => `${k}=${v}`)
                              .join(" ")
                        : "",
                })) as { inputEnv: string };

                if (inputEnv.trim()) {
                    env = parseEnvString(inputEnv.trim());
                    logger.info(`Parsed ${Object.keys(env).length} environment variable(s)`);
                } else if (inputEnv.trim() === "" && serverConfig?.env) {
                    // If user cleared it, we should probably clear it too, but parseEnvString returns {} for empty
                    env = {};
                }
            } catch (error: any) {
                if (error.message === "canceled") {
                    logger.info("\nOperation cancelled by user.");
                    return;
                }
                throw error;
            }

            if (Object.keys(env).length > 0) {
                newServerConfig.env = env;
            }
        }

        // Preserve _meta if it exists
        if (serverConfig?._meta) {
            newServerConfig._meta = serverConfig._meta;
        }

        serverConfig = newServerConfig;

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
