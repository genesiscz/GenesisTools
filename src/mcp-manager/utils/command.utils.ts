import logger from "@app/logger";
import { ExitPromptError } from "@inquirer/core";
import { checkbox } from "@inquirer/prompts";
import type { MCPProvider, UnifiedMCPConfig } from "./providers/types.js";

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
  config-json               Output servers as JSON in standard client format
                            Options: --client, --enabled-only, --servers, --bare, --clipboard

Options:
  --path                   (config) Only print config file path, don't open editor
  -t, --type <type>        Transport type (stdio, sse, http) for install
  -H, --headers <str>      Headers for http/sse (uses colon separator: "Key: value")
                           Can be used multiple times: --headers "Auth: token" --headers "X-Api: key"
  -e, --env <str>          Env vars for stdio (uses equals separator: "KEY=value")
                           Can be used multiple times: --env "KEY1=val1" --env "KEY2=val2"
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

  # Install stdio server with env vars (multiple --env flags supported)
  tools mcp-manager install my-server "npx -y @org/server" --type stdio \\
    --env "API_KEY=xxx" --env "TOKEN=yyy" --provider claude

  # Install http server with headers (uses colon separator, multiple flags supported)
  tools mcp-manager install jina-ai "https://api.jina.ai/mcp" --type http \\
    --headers "Authorization: Bearer YOUR_TOKEN" --provider claude

  # Install with Basic Auth (base64 values with = padding work correctly)
  tools mcp-manager install jenkins "https://jenkins.example.com/mcp" --type http \\
    --headers "Authorization: Basic cWtmb2x0eW5tYXI6YWJjMTIz==" --provider claude

  # Enable/disable with specific provider
  tools mcp-manager enable github --provider claude
  tools mcp-manager disable omnisearch --provider claude,cursor

  # Show server config
  tools mcp-manager show github

  # Output servers as JSON (all servers)
  tools mcp-manager config-json

  # Output only enabled servers for claude format
  tools mcp-manager config-json --client claude --enabled-only

  # Output specific servers, copy to clipboard
  tools mcp-manager config-json --servers github,filesystem --clipboard

  # Output bare mcpServers object without wrapper
  tools mcp-manager config-json --bare
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
 * Parse a single key-value pair using a separator.
 * Only splits on the FIRST occurrence of the separator.
 * @param input - The input string (e.g., "Key: value" or "KEY=value")
 * @param separator - The separator character (e.g., ":" or "=")
 * @returns The key-value pair, or null if invalid format
 */
function parseSinglePair(input: string, separator: string): { key: string; value: string } | null {
    const str = input.trim();
    if (!str) return null;

    const sepIndex = str.indexOf(separator);
    if (sepIndex <= 0) return null; // No separator or starts with separator

    const key = str.slice(0, sepIndex).trim();
    let value = str.slice(sepIndex + 1).trim();

    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }

    return { key, value };
}

/**
 * Parse header string(s) into object.
 * Uses COLON as separator (follows HTTP header format).
 * Supports:
 *   - Single header: "Authorization: Bearer token"
 *   - Multiple headers via array: ["Auth: token", "X-Custom: value"]
 *   - JSON format: '{"Key": "value"}'
 *
 * Examples:
 *   "Authorization: Basic abc123==" -> { "Authorization": "Basic abc123==" }
 *   ["Auth: token", "X-Api-Key: secret"] -> { "Auth": "token", "X-Api-Key": "secret" }
 */
export function parseHeaderString(input: string | string[]): Record<string, string> {
    const headers: Record<string, string> = {};

    // Handle array input (multiple --headers flags)
    const inputs = Array.isArray(input) ? input : [input];

    for (const item of inputs) {
        const trimmed = item.trim();
        if (!trimmed) continue;

        // Try JSON format first
        if (trimmed.startsWith("{")) {
            try {
                const parsed = JSON.parse(trimmed);
                Object.assign(headers, parsed);
                continue;
            } catch {
                // Not valid JSON, try as key:value pair
            }
        }

        // Parse as "Key: value" format
        const pair = parseSinglePair(trimmed, ":");
        if (pair) {
            headers[pair.key] = pair.value;
        }
    }

    return headers;
}

/**
 * Parse ENV string(s) into object.
 * Uses EQUALS as separator.
 * Supports:
 *   - Single env: "KEY=value with spaces and = signs"
 *   - Multiple envs via array: ["KEY1=val1", "KEY2=val2"]
 *   - JSON format: '{"KEY": "value"}'
 *
 * Examples:
 *   "API_KEY=abc123==" -> { "API_KEY": "abc123==" }
 *   ["KEY1=val1", "KEY2=val2"] -> { "KEY1": "val1", "KEY2": "val2" }
 */
export function parseEnvString(input: string | string[]): Record<string, string> {
    const env: Record<string, string> = {};

    // Handle array input (multiple --env flags)
    const inputs = Array.isArray(input) ? input : [input];

    for (const item of inputs) {
        const trimmed = item.trim();
        if (!trimmed) continue;

        // Try JSON format first
        if (trimmed.startsWith("{")) {
            try {
                const parsed: unknown = JSON.parse(trimmed);
                // Validate parsed JSON is a Record<string, string>
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    for (const [key, value] of Object.entries(parsed)) {
                        if (typeof key === "string" && typeof value === "string") {
                            env[key] = value;
                        }
                    }
                }
                continue;
            } catch {
                // Not valid JSON, try as key=value pair
            }
        }

        // Parse as "KEY=value" format (split on first = only)
        const pair = parseSinglePair(trimmed, "=");
        if (pair) {
            env[pair.key] = pair.value;
        }
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
export function parseProviderNames(providerInput: string, availableProviders: MCPProvider[]): string[] | null {
    const providerNames = providerInput
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
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
        const selectedServers = await checkbox({
            message,
            choices: serverNames.map((name) => ({ value: name, name })),
            pageSize: 30,
            loop: false,
        });

        return selectedServers;
    } catch (error) {
        if (error instanceof ExitPromptError) {
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
        const selectedProviders = await checkbox({
            message,
            choices: availableProviders.map((p) => ({
                value: p.getName(),
                name: `${p.getName()} (${p.getConfigPath()})`,
            })),
        });

        return selectedProviders;
    } catch (error) {
        if (error instanceof ExitPromptError) {
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
            value: "global",
            name: "Global (all projects)",
        },
        ...projects.map((projectPath) => ({
            value: projectPath,
            name: projectPath,
        })),
    ];

    try {
        const selectedProjects = await checkbox({
            message,
            choices,
            pageSize: 200,
            loop: false,
        });

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
    } catch (error) {
        if (error instanceof ExitPromptError) {
            logger.info("\nOperation cancelled by user.");
            return null;
        }
        throw error;
    }
}
