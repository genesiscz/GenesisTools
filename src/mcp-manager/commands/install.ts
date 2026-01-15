import { search, input, select } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger from "@app/logger";
import type { UnifiedMCPServerConfig, MCPProvider } from "../utils/providers/types.js";
import { readUnifiedConfig, writeUnifiedConfig, stripMeta } from "../utils/config.utils.js";
import { parseCommandString, parseEnvString, parseHeaderString } from "../utils/command.utils.js";

export interface InstallOptions {
    type?: string; // stdio, sse, http
    headers?: string | string[]; // "Key: value" format (colon separator) for http/sse
    env?: string | string[]; // "KEY=value" format for stdio
    provider?: string; // Provider name to install to (non-interactive)
}

/**
 * Install/add an MCP server configuration
 * @param serverName - Server name
 * @param commandOrUrl - Command for stdio or URL for sse/http
 * @param providers - Available providers
 * @param options - Additional options for non-interactive mode
 */
export async function installServer(
    serverName: string | undefined,
    commandOrUrl: string | undefined,
    providers: MCPProvider[],
    options: InstallOptions = {}
): Promise<void> {
    const config = await readUnifiedConfig();
    let finalServerName = serverName;
    let serverConfig: UnifiedMCPServerConfig | undefined;

    // Create new server constant
    const CREATE_NEW = "__create_new__";

    // Check if we're in non-interactive mode (all required args provided)
    const isNonInteractive = !!(serverName && commandOrUrl && options.type);

    // Scenario 1: No server name provided - prompt for it with autocomplete
    if (!finalServerName) {
        if (isNonInteractive || options.provider) {
            logger.error("Server name is required for non-interactive mode.");
            process.exit(1);
        }
        try {
            const existingServers = Object.keys(config.mcpServers).sort();
            const choices = [
                { value: CREATE_NEW, name: chalk.cyan("+ Create new server...") },
                ...existingServers.map((name) => ({ value: name, name })),
            ];

            const inputServerName = await search({
                message: "Select server to install or create new:",
                source: async (term) => {
                    if (!term) return choices;
                    const lowerTerm = term.toLowerCase();
                    return choices.filter((c) => c.name.toLowerCase().includes(lowerTerm));
                },
                pageSize: 30,
            });

            if (inputServerName === CREATE_NEW) {
                const newServerName = await input({
                    message: "Enter name for the new server:",
                    validate: (value: string) => (value.trim() ? true : "Server name cannot be empty."),
                });
                finalServerName = newServerName.trim();
            } else {
                finalServerName = inputServerName.trim();
            }

            if (!finalServerName) {
                logger.warn("Server name cannot be empty.");
                return;
            }
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info("\nOperation cancelled by user.");
                return;
            }
            throw error;
        }
    }

    // Check if server exists in unified config
    serverConfig = config.mcpServers[finalServerName];

    // Scenario 2 & 3: Server doesn't exist OR command/url provided - collect server info
    if (!serverConfig || commandOrUrl || options.type) {
        let transportType = options.type as "stdio" | "sse" | "http" | undefined;

        // If type not provided and non-interactive mode, error out
        if (!transportType && isNonInteractive) {
            logger.error("Transport type (--type) is required for non-interactive mode.");
            process.exit(1);
        }

        // If it's a new server or we're overwriting, ask for details
        if (!transportType) {
            try {
                const inputType = await select({
                    message: "Select transport type:",
                    choices: [
                        { value: "stdio", name: "stdio (Local executable/npx)" },
                        { value: "sse", name: "sse (Server-Sent Events / Remote URL)" },
                        { value: "http", name: "http (Remote HTTP endpoint)" },
                    ],
                    default: serverConfig?.type || "stdio",
                });
                transportType = inputType as "stdio" | "sse" | "http";
            } catch (error) {
                if (error instanceof ExitPromptError) {
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
                const inputVal = await input({
                    message: isRemote
                        ? `Enter URL (e.g., "https://server.example.com/sse"):`
                        : 'Enter command (e.g., "npx -y @modelcontextprotocol/server-github"):',
                    default: isRemote ? serverConfig?.url || serverConfig?.httpUrl : serverConfig?.command,
                });

                finalCommandOrUrl = inputVal.trim();

                if (!finalCommandOrUrl) {
                    logger.warn("Value cannot be empty.");
                    return;
                }
            } catch (error) {
                if (error instanceof ExitPromptError) {
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

            // Handle headers - from option or interactive prompt
            if (options.headers) {
                // Non-interactive: use provided headers (supports "Key: value" format with colon separator)
                try {
                    newServerConfig.headers = parseHeaderString(options.headers);
                } catch (error: unknown) {
                    if (error instanceof Error) {
                        logger.error(`Failed to parse headers: ${error.message}`);
                    }
                    process.exit(1);
                }
            } else if (!isNonInteractive) {
                // Interactive: ask for headers
                try {
                    const inputHeaders = await input({
                        message: 'Enter optional headers ("Key: value" format or JSON) or leave empty:',
                        default: serverConfig?.headers ? JSON.stringify(serverConfig.headers) : "",
                    });

                    if (inputHeaders.trim()) {
                        newServerConfig.headers = parseHeaderString(inputHeaders);
                    }
                } catch (error) {
                    if (error instanceof ExitPromptError) {
                        logger.info("\nOperation cancelled by user.");
                        return;
                    }
                    if (error instanceof Error) {
                        logger.warn(`Failed to parse headers: ${error.message}. Skipping headers.`);
                    }
                }
            }
        } else {
            // stdio
            try {
                const parsed = parseCommandString(finalCommandOrUrl);
                newServerConfig.command = parsed.command;
                newServerConfig.args = parsed.args;
            } catch (error: unknown) {
                if (error instanceof Error) {
                    logger.error(`Failed to parse command: ${error.message}`);
                }
                return;
            }

            // Handle ENV variables - from option or interactive prompt (supports "KEY=value" format)
            let env: Record<string, string> = serverConfig?.env || {};
            if (options.env) {
                // Non-interactive: use provided env (supports array for multiple --env flags)
                env = parseEnvString(options.env);
                if (Object.keys(env).length > 0) {
                    logger.info(`Parsed ${Object.keys(env).length} environment variable(s)`);
                }
            } else if (!isNonInteractive) {
                // Interactive: ask for env
                try {
                    const inputEnv = await input({
                        message: 'Enter ENV variables ("KEY=value" format or JSON) or leave empty:',
                        default: serverConfig?.env
                            ? Object.entries(serverConfig.env)
                                  .map(([k, v]) => `${k}=${v}`)
                                  .join(" ")
                            : "",
                    });

                    if (inputEnv.trim()) {
                        env = parseEnvString(inputEnv);
                        logger.info(`Parsed ${Object.keys(env).length} environment variable(s)`);
                    } else if (inputEnv.trim() === "" && serverConfig?.env) {
                        // If user cleared it, we should probably clear it too, but parseEnvString returns {} for empty
                        env = {};
                    }
                } catch (error) {
                    if (error instanceof ExitPromptError) {
                        logger.info("\nOperation cancelled by user.");
                        return;
                    }
                    throw error;
                }
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

    let selectedProviderNames: string[];
    if (options.provider) {
        // Filter to the specified provider
        const requestedProvider = availableProviders.find(
            (p) => p.getName().toLowerCase() === options.provider!.toLowerCase()
        );
        if (!requestedProvider) {
            logger.error(
                `Provider '${options.provider}' not found. Available: ${availableProviders.map((p) => p.getName()).join(", ")}`
            );
            process.exit(1);
        }
        selectedProviderNames = [requestedProvider.getName()];
    } else if (isNonInteractive) {
        logger.error(
            `Provider (--provider) is required for non-interactive mode. Available: ${availableProviders.map((p) => p.getName()).join(", ")}`
        );
        process.exit(1);
    } else {
        try {
            const selectedProvider = await select({
                message: "Select provider to install to:",
                choices: availableProviders.map((p) => ({
                    value: p.getName(),
                    name: `${p.getName()} (${p.getConfigPath()})`,
                })),
            });
            selectedProviderNames = [selectedProvider];
        } catch (error) {
            if (error instanceof ExitPromptError) {
                logger.info("\nOperation cancelled by user.");
                return;
            }
            throw error;
        }
    }

    const configToInstall = stripMeta(serverConfig);

    // Install to each selected provider
    for (const providerName of selectedProviderNames) {
        const provider = availableProviders.find((p) => p.getName() === providerName);
        if (!provider) continue;

        const installed = await provider.installServer(finalServerName, configToInstall);
        if (installed) {
            logger.info(`✓ Installed '${finalServerName}' to ${providerName}`);
        }
    }
}
