import Enquirer from "enquirer";
import logger from "@app/logger";
import type { UnifiedMCPConfig } from "./providers/types.js";
import type { MCPProvider } from "./providers/types.js";

const prompter = new Enquirer();

/**
 * Show help message for the mcp-manager tool
 */
export function showHelp() {
    logger.info(`
Usage: tools mcp-manager [command] [options]

Manage MCP (Model Context Protocol) servers across multiple AI assistants.

Commands:
  config                    Open/create unified configuration file
  sync                      Sync MCP servers from unified config to selected providers
  sync-from-providers       Sync servers FROM providers TO unified config
  list                      List all MCP servers across all providers
  enable <servers>          Enable MCP server(s) in a provider (comma-separated or interactive)
  disable <servers>         Disable MCP server(s) in a provider (comma-separated or interactive)
  install [server] ["cmd"]  Install/add an MCP server to a provider
                            - No args: Interactive prompt for all details
                            - Name only: Prompt for command if server doesn't exist
                            - Name + command: Create/update server and install
  show <server>             Show full configuration of an MCP server
  backup-all                Backup all configs for all providers
  rename [old] [new]        Rename an MCP server key across unified config and providers
                            - No args: Interactive prompts for old and new names
                            - Old name only: Prompt for new name
                            - Old + new names: Rename directly

Options:
  -v, --verbose            Enable verbose logging
  -h, --help               Show this help message

Examples:
  tools mcp-manager config
  tools mcp-manager sync
  tools mcp-manager sync-from-providers
  tools mcp-manager list
  tools mcp-manager enable github
  tools mcp-manager enable server1,server2,server3
  tools mcp-manager disable github
  tools mcp-manager disable foo,bar,baz
  tools mcp-manager install
  tools mcp-manager install github
  tools mcp-manager install my-server "npx -y @modelcontextprotocol/server-github"
  tools mcp-manager show github
  tools mcp-manager backup-all
  tools mcp-manager rename
  tools mcp-manager rename old-server-name
  tools mcp-manager rename old-server-name new-server-name
`);
}

/**
 * Parse a command string into command and args.
 * Example: "npx -y @modelcontextprotocol/server-github" -> { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
 */
export function parseCommandString(commandString: string): { command: string; args: string[] } {
    const parts = commandString.trim().split(/\s+/);
    if (parts.length === 0) {
        throw new Error("Command string cannot be empty");
    }
    const command = parts[0];
    const args = parts.slice(1);
    return { command, args };
}

/**
 * Parse ENV string into object.
 * Example: "KEY1=value1 KEY2=value2" -> { "KEY1": "value1", "KEY2": "value2" }
 */
export function parseEnvString(envString: string): Record<string, string> {
    if (!envString.trim()) {
        return {};
    }

    const env: Record<string, string> = {};
    const regex = /(\w+)=([^\s]+)/g;
    let match;

    while ((match = regex.exec(envString)) !== null) {
        env[match[1]] = match[2];
    }

    return env;
}

/**
 * Parse comma-delimited server names from input string
 */
export function parseServerNames(input?: string): string[] {
    if (!input) return [];

    if (input.includes(",")) {
        return input
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }

    return [input];
}

/**
 * Validate that all provided server names exist in the unified config
 */
export function validateServerNames(
    serverNames: string[],
    config: UnifiedMCPConfig
): { valid: boolean; invalidServers: string[] } {
    const invalidServers = serverNames.filter((name) => !config.mcpServers[name]);
    return {
        valid: invalidServers.length === 0,
        invalidServers,
    };
}

/**
 * Prompt user to select servers from unified config
 */
export async function promptForServers(config: UnifiedMCPConfig, message: string): Promise<string[] | null> {
    const serverNames = Object.keys(config.mcpServers).sort();

    if (serverNames.length === 0) {
        logger.warn("No servers found in unified config.");
        return null;
    }

    try {
        console.log(serverNames);
        const { selectedServers } = (await prompter.prompt({
            type: "multiselect",
            name: "selectedServers",
            message,
            choices: serverNames,
            limit: 30,
            scroll: false,
        } as any)) as { selectedServers: string[] };

        return selectedServers;
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return null;
        }
        throw error;
    }
}

/**
 * Get and validate server names from args or prompt
 */
export async function getServerNames(
    serverNameArg: string | undefined,
    config: UnifiedMCPConfig,
    promptMessage: string
): Promise<string[] | null> {
    const parsedNames = parseServerNames(serverNameArg);

    // If names provided via args, validate them
    if (parsedNames.length > 0) {
        const validation = validateServerNames(parsedNames, config);
        if (!validation.valid) {
            for (const invalidName of validation.invalidServers) {
                logger.warn(`Server '${invalidName}' not found in unified config.`);
            }
            return null;
        }
        return parsedNames;
    }

    // Otherwise, prompt for selection
    return await promptForServers(config, promptMessage);
}

/**
 * Prompt user to select providers
 */
export async function promptForProviders(availableProviders: MCPProvider[], message: string): Promise<string[] | null> {
    if (availableProviders.length === 0) {
        logger.warn("No provider configuration files found.");
        return null;
    }

    try {
        const { selectedProviders } = (await prompter.prompt({
            type: "multiselect",
            name: "selectedProviders",
            message,
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProviders: string[] };

        return selectedProviders;
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return null;
        }
        throw error;
    }
}

/**
 * Project selection choice for Claude
 */
export interface ProjectChoice {
    projectPath: string | null; // null means "Global (all projects)"
    displayName: string;
}

/**
 * Prompt user to select projects for a provider that supports project-level configuration
 */
export async function promptForProjects(projects: string[], message: string): Promise<ProjectChoice[] | null> {
    const choices = [
        {
            name: "global",
            message: "Global (all projects)",
        },
        ...projects.map((projectPath) => ({
            name: projectPath,
            message: projectPath,
        })),
    ];

    try {
        const { selectedProjects } = (await prompter.prompt({
            type: "multiselect",
            name: "selectedProjects",
            message,
            choices,
            limit: 200,
            scroll: false,
        } as any)) as { selectedProjects: string[] };

        return selectedProjects.map((choice) => {
            if (choice === "global") {
                return {
                    projectPath: null,
                    displayName: "Global (all projects)",
                };
            }
            return {
                projectPath: choice,
                displayName: choice,
            };
        });
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return null;
        }
        throw error;
    }
}
