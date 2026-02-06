import { Command } from "commander";
import { select, input } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import logger, { configureLogger } from "@app/logger";
import { ClaudeProvider } from "./utils/providers/claude.js";
import { GeminiProvider } from "./utils/providers/gemini.js";
import { CodexProvider } from "./utils/providers/codex.js";
import { CursorProvider } from "./utils/providers/cursor.js";
import type { MCPProvider } from "./utils/providers/types.js";
import { showHelp } from "./utils/command.utils.js";
import { handleReadmeFlag } from "@app/utils/readme";

// Handle --readme flag early (before Commander parses)
handleReadmeFlag(import.meta.url);

import {
    openConfig,
    syncServers,
    syncFromProviders,
    listServers,
    enableServer,
    disableServer,
    installServer,
    showServerConfig,
    backupAllConfigs,
    renameServer,
    configJson,
} from "./commands/index.js";
import { setGlobalOptions } from "./utils/config.utils.js";

// Configure logger to include timestamps in console output and enable sync mode
// Sync mode ensures logs appear before Inquirer prompts
configureLogger({
    includeTimestamp: true,
    timestampFormat: "HH:MM:ss",
    sync: true,
});

/**
 * Get all available providers
 */
function getProviders(): MCPProvider[] {
    return [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider()];
}

/**
 * Parse and validate provider argument
 */
function parseProviderArg(providerArg: string | undefined, allProviders: MCPProvider[]): MCPProvider[] {
    if (!providerArg) {
        return allProviders;
    }

    // Handle both string and array (multiple --provider flags)
    const rawNames: string[] = Array.isArray(providerArg)
        ? providerArg.flatMap((p: string) => p.split(","))
        : providerArg.split(",");
    const requestedNames = rawNames.map((p) => p.trim()).filter(Boolean);

    // Handle "all" special case
    if (requestedNames.length === 1 && requestedNames[0].toLowerCase() === "all") {
        return allProviders;
    }

    const validatedProviders: MCPProvider[] = [];
    for (const name of requestedNames) {
        const provider = allProviders.find((p) => p.getName().toLowerCase() === name.toLowerCase());
        if (!provider) {
            logger.error(
                `Provider '${name}' not found. Available: ${allProviders.map((p) => p.getName()).join(", ")}, all`
            );
            process.exit(1);
        }
        // Avoid duplicates
        if (!validatedProviders.includes(provider)) {
            validatedProviders.push(provider);
        }
    }
    return validatedProviders;
}

// Create the program
const program = new Command()
    .name("mcp-manager")
    .description("Manage MCP (Model Context Protocol) servers across multiple AI assistants")
    .option("-v, --verbose", "Enable verbose logging")
    .option("-y, --yes", "Auto-confirm changes without prompting (only after you do the command without --yes and check the diff)")
    .option("-p, --provider <name>", "Provider name(s) for operations (claude, cursor, gemini, codex, or 'all')")
    .option("-?, --help-full", "Show detailed help message")
    .helpCommand(true)
    .hook("preAction", () => {
        // Set global options for all commands (enables --yes to work globally)
        const opts = program.opts();
        setGlobalOptions({ yes: opts.yes });
    });

// Handle --help-full to show custom help
program.on("option:help-full", () => {
    showHelp();
    process.exit(0);
});

// config command
program
    .command("config")
    .description("Open/create unified configuration file")
    .option("--path", "Only print config file path, don't open editor")
    .action(async (options) => {
        await openConfig({ path: options.path });
    });

// sync command
program
    .command("sync")
    .description("Sync MCP servers from unified config to providers")
    .action(async () => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await syncServers(providers, { provider: opts.provider });
    });

// sync-from-providers command
program
    .command("sync-from-providers")
    .description("Sync servers FROM providers TO unified config")
    .action(async () => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await syncFromProviders(providers, { provider: opts.provider });
    });

// list command
program
    .command("list")
    .description("List all MCP servers across all providers")
    .action(async () => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await listServers(providers);
    });

// enable command
program
    .command("enable [servers]")
    .description("Enable MCP server(s) in provider(s)")
    .action(async (servers) => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await enableServer(servers, providers, { provider: opts.provider });
    });

// disable command
program
    .command("disable [servers]")
    .description("Disable MCP server(s) in provider(s)")
    .action(async (servers) => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await disableServer(servers, providers, { provider: opts.provider });
    });

// install command
program
    .command("install [server] [command]")
    .description("Install/add an MCP server to a provider")
    .option("-t, --type <type>", "Transport type (stdio, sse, http)")
    .option("-H, --headers <str>", "Headers for http/sse (uses colon separator: 'Key: value')", (val, prev: string[]) => prev ? [...prev, val] : [val], [])
    .option("-e, --env <str>", "Env vars for stdio (uses equals separator: 'KEY=value')", (val, prev: string[]) => prev ? [...prev, val] : [val], [])
    .action(async (server, command, options) => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await installServer(server, command, providers, {
            type: options.type,
            headers: options.headers?.length > 0 ? options.headers : undefined,
            env: options.env?.length > 0 ? options.env : undefined,
            provider: opts.provider,
        });
    });

// show command
program
    .command("show [server]")
    .description("Show full configuration of an MCP server")
    .action(async (server) => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await showServerConfig(server || "", providers);
    });

// backup-all command
program
    .command("backup-all")
    .description("Backup all configs for all providers")
    .action(async () => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await backupAllConfigs(providers);
    });

// rename command
program
    .command("rename [oldName] [newName]")
    .description("Rename an MCP server key across unified config and providers")
    .action(async (oldName, newName) => {
        const opts = program.opts();
        const providers = parseProviderArg(opts.provider, getProviders());
        await renameServer(oldName, newName, providers);
    });

// config-json command
program
    .command("config-json")
    .description("Output servers as JSON in standard client format")
    .option("--client <type>", "Client format (standard, cursor, claude)")
    .option("--enabled-only", "Only include enabled servers")
    .option("--servers <names>", "Specific servers to include (comma-separated)")
    .option("--bare", "Output bare mcpServers object without wrapper")
    .option("-c, --clipboard", "Copy output to clipboard")
    .action(async (options) => {
        await configJson({
            client: options.client as "standard" | "cursor" | "claude" | undefined,
            enabledOnly: options.enabledOnly,
            servers: options.servers,
            bare: options.bare,
            clipboard: options.clipboard,
        });
    });

// Default action (interactive mode) when no command is specified
program.action(async () => {
    const opts = program.opts();
    const allProviders = getProviders();
    const providers = parseProviderArg(opts.provider, allProviders);

    try {
        const action = await select({
            message: "What would you like to do?",
            choices: [
                { value: "config", name: "Open/edit unified configuration" },
                { value: "sync", name: "Sync servers to providers" },
                { value: "syncFromProviders", name: "Sync servers from providers" },
                { value: "list", name: "List all servers" },
                { value: "enable", name: "Enable servers" },
                { value: "disable", name: "Disable servers" },
                { value: "install", name: "Install a server" },
                { value: "show", name: "Show server configuration" },
                { value: "backupAll", name: "Backup all configs" },
                { value: "rename", name: "Rename a server" },
            ],
        });

        switch (action) {
            case "config":
                await openConfig();
                break;
            case "sync":
                await syncServers(providers);
                break;
            case "syncFromProviders":
                await syncFromProviders(providers);
                break;
            case "list":
                await listServers(providers);
                break;
            case "enable":
                await enableServer(undefined, providers);
                break;
            case "disable":
                await disableServer(undefined, providers);
                break;
            case "install":
                await installServer(undefined, undefined, providers);
                break;
            case "show": {
                const serverName = await input({
                    message: "Server name:",
                });
                await showServerConfig(serverName, providers);
                break;
            }
            case "backupAll":
                await backupAllConfigs(providers);
                break;
            case "rename":
                await renameServer(undefined, undefined, providers);
                break;
        }
    } catch (error) {
        if (error instanceof ExitPromptError) {
            logger.info("\nOperation cancelled by user.");
            process.exit(0);
        }
        throw error;
    }
});

// Main function
async function main() {
    try {
        await program.parseAsync();
    } catch (error: unknown) {
        const opts = program.opts();
        if (error instanceof Error) {
            logger.error(`✖ Error: ${error.message}`);
            if (opts.verbose) {
                logger.error(error.stack);
            }
        } else {
            logger.error(`✖ Error: ${error}`);
        }
        process.exit(1);
    }
}

// Run the tool
main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
