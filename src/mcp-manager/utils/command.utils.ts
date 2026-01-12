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
                            Shows config path, then opens in editor
  sync                      Sync MCP servers from unified config to providers
                            Use --provider for non-interactive mode
  sync-from-providers       Sync servers FROM providers TO unified config
                            Use --provider for non-interactive mode
  list                      List all MCP servers across all providers
  enable <servers>          Enable MCP server(s) in provider(s)
                            Use --provider for non-interactive mode
  disable <servers>         Disable MCP server(s) in provider(s)
                            Use --provider for non-interactive mode
  install [server] ["cmd"]  Install/add an MCP server to a provider
                            - No args: Interactive prompt for all details
                            - Name + command + type: Non-interactive (requires --provider)
  show <server>             Show full configuration of an MCP server
  backup-all                Backup all configs for all providers
  rename [old] [new]        Rename an MCP server key across unified config and providers
                            - No args: Interactive prompts for old and new names
                            - Old name only: Prompt for new name
                            - Old + new names: Rename directly

Options:
  --path                   (config) Only print config file path, don't open editor
  -t, --type <type>        Transport type (stdio, sse, http) for install
  -H, --headers <str>      Headers for http/sse (supports spaces: "Auth=Bearer token")
  -e, --env <str>          Env vars for stdio ("KEY=val" or 'KEY="val with spaces"')
  -p, --provider <name>    Provider name for non-interactive mode (claude, cursor, gemini, codex)
  -v, --verbose            Enable verbose logging
  -h, --help               Show this help message

Interactive Examples:
  tools mcp-manager config
  tools mcp-manager sync
  tools mcp-manager list
  tools mcp-manager install
  tools mcp-manager enable github
  tools mcp-manager disable github

Non-Interactive Examples (for scripts and AI assistants):
  # Show config path without opening editor
  tools mcp-manager config --path

  # Sync to/from specific providers
  tools mcp-manager sync --provider claude,gemini,codex,cursor
  tools mcp-manager sync-from-providers --provider claude

  # Install stdio server with env vars
  tools mcp-manager install my-server "npx -y @org/server" --type stdio \\
    --env "API_KEY=xxx TOKEN=yyy" --provider claude

  # Install http server with headers (spaces in value work)
  tools mcp-manager install jina-ai "https://api.jina.ai/mcp" --type http \\
    --headers "Authorization=Bearer YOUR_TOKEN" --provider claude

  # Enable/disable with specific provider
  tools mcp-manager enable github --provider claude
  tools mcp-manager disable omnisearch --provider claude,cursor

  # Show server config
  tools mcp-manager show github
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
 * Parse ENV/headers string into object.
 * Supports:
 *   - Unquoted: KEY=value (no spaces in value)
 *   - Quoted: KEY="value with spaces" or KEY='value with spaces'
 *   - Single pair: Authorization=Bearer token (entire rest is value)
 * Examples:
 *   "KEY1=value1 KEY2=value2" -> { "KEY1": "value1", "KEY2": "value2" }
 *   'Authorization="Bearer token"' -> { "Authorization": "Bearer token" }
 *   "Authorization=Bearer token" -> { "Authorization": "Bearer token" } (single pair)
 */
export function parseEnvString(envString: string): Record<string, string> {
    if (!envString.trim()) {
        return {};
    }

    const env: Record<string, string> = {};
    const str = envString.trim();

    // Check if it's a single KEY=value pair (no other = signs after the first one's value)
    const firstEq = str.indexOf("=");
    if (firstEq > 0) {
        const afterFirst = str.slice(firstEq + 1);
        // If no unquoted KEY= pattern in the rest, treat as single pair
        if (!/\s+\w+=/.test(afterFirst)) {
            const key = str.slice(0, firstEq);
            let value = afterFirst;
            // Strip surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            env[key] = value;
            return env;
        }
    }

    // Multiple pairs: match KEY=value or KEY="value" or KEY='value'
    const regex = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
    let match;

    while ((match = regex.exec(str)) !== null) {
        const key = match[1];
        // Value is in group 2 (double-quoted), 3 (single-quoted), or 4 (unquoted)
        const value = match[2] ?? match[3] ?? match[4];
        env[key] = value;
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
 * Parse and validate comma-separated provider names
 * @param providerInput - Comma-separated provider names (e.g., "claude,gemini,codex")
 * @param availableProviders - List of available provider instances
 * @returns Array of validated provider names, or null if any invalid
 */
export function parseProviderNames(
    providerInput: string,
    availableProviders: MCPProvider[]
): string[] | null {
    const providerNames = providerInput.split(",").map((p) => p.trim()).filter(Boolean);
    const validProviders: string[] = [];

    for (const name of providerNames) {
        const provider = availableProviders.find((p) => p.getName().toLowerCase() === name.toLowerCase());
        if (!provider) {
            logger.error(
                `Provider '${name}' not found. Available: ${availableProviders.map((p) => p.getName()).join(", ")}`
            );
            return null;
        }
        validProviders.push(provider.getName());
    }

    return validProviders;
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
