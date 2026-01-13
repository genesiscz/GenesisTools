import minimist from "minimist";
import Enquirer from "enquirer";
import logger, { configureLogger } from "@app/logger";
import { ClaudeProvider } from "./utils/providers/claude.js";
import { GeminiProvider } from "./utils/providers/gemini.js";
import { CodexProvider } from "./utils/providers/codex.js";
import { CursorProvider } from "./utils/providers/cursor.js";
import type { MCPProvider } from "./utils/providers/types.js";
import { showHelp } from "./utils/command.utils.js";
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
} from "./commands/index.js";
import { setGlobalOptions } from "./utils/config.utils.js";

// Configure logger to include timestamps in console output and enable sync mode
// Sync mode ensures logs appear before Enquirer prompts
configureLogger({
    includeTimestamp: true,
    timestampFormat: "HH:MM:ss",
    sync: true,
});

// Define options interface
interface Options {
    config?: boolean;
    path?: boolean; // For config --path
    sync?: boolean;
    syncFromProviders?: boolean;
    list?: boolean;
    enable?: string;
    disable?: string;
    install?: string;
    show?: string;
    backupAll?: boolean;
    rename?: string;
    type?: string;
    headers?: string; // For install --headers
    env?: string; // For install --env
    provider?: string; // For install/enable/disable --provider
    providers?: string; // Alias for --provider
    yes?: boolean; // Auto-confirm changes without prompting
    verbose?: boolean;
    help?: boolean;
}

interface Args extends Options {
    _: string[];
}

// Create Enquirer instance
const prompter = new Enquirer();

/**
 * Get all available providers
 */
function getProviders(): MCPProvider[] {
    return [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider()];
}

// Main function
async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            v: "verbose",
            h: "help",
            t: "type",
            p: ["provider", "providers"], // Both --provider and --providers work
            H: "headers",
            e: "env",
            y: "yes",
        },
        boolean: ["verbose", "help", "config", "sync", "syncFromProviders", "list", "backupAll", "path", "yes"],
        string: ["enable", "disable", "install", "show", "rename", "type", "headers", "env", "provider", "providers"],
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    // Set global options for use by BackupManager and other utilities
    setGlobalOptions({ yes: argv.yes });

    const allProviders = getProviders();

    // Parse and validate --provider/--providers flag if specified
    // Supports: --provider claude,gemini OR --provider claude --provider gemini OR --provider all
    let providers = allProviders;
    const providerArg = argv.provider || argv.providers;
    if (providerArg) {
        // Handle both string and array (multiple --provider flags)
        const rawNames: string[] = Array.isArray(providerArg)
            ? providerArg.flatMap((p: string) => p.split(","))
            : providerArg.split(",");
        const requestedNames = rawNames.map((p) => p.trim()).filter(Boolean);

        // Handle "all" special case
        if (requestedNames.length === 1 && requestedNames[0].toLowerCase() === "all") {
            providers = allProviders;
        } else {
            const validatedProviders: typeof allProviders = [];
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
            providers = validatedProviders;
        }
    }

    try {
        const command =
            argv._[0] ||
            (argv.config
                ? "config"
                : argv.sync
                ? "sync"
                : argv.syncFromProviders || argv["sync-from-providers"]
                ? "sync-from-providers"
                : argv.list
                ? "list"
                : argv.backupAll || argv["backup-all"]
                ? "backup-all"
                : null);

        if (!command) {
            // Interactive mode
            try {
                const { action } = (await prompter.prompt({
                    type: "select",
                    name: "action",
                    message: "What would you like to do?",
                    choices: [
                        { name: "config", message: "Open/edit unified configuration" },
                        { name: "sync", message: "Sync servers to providers" },
                        { name: "syncFromProviders", message: "Sync servers from providers" },
                        { name: "list", message: "List all servers" },
                        { name: "enable", message: "Enable servers" },
                        { name: "disable", message: "Disable servers" },
                        { name: "install", message: "Install a server" },
                        { name: "show", message: "Show server configuration" },
                        { name: "backupAll", message: "Backup all configs" },
                        { name: "rename", message: "Rename a server" },
                    ],
                })) as { action: string };

                switch (action) {
                    case "config":
                        await openConfig({ path: argv.path });
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
                        const { serverName } = (await prompter.prompt({
                            type: "input",
                            name: "serverName",
                            message: "Server name:",
                        })) as { serverName: string };
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
            } catch (error: any) {
                if (error.message === "canceled") {
                    logger.info("\nOperation cancelled by user.");
                    process.exit(0);
                }
                throw error;
            }
        } else {
            // Command mode
            switch (command) {
                case "config":
                    await openConfig({ path: argv.path });
                    break;
                case "sync":
                    await syncServers(providers, { provider: argv.provider });
                    break;
                case "sync-from-providers":
                case "syncFromProviders":
                    await syncFromProviders(providers, { provider: argv.provider });
                    break;
                case "list":
                    await listServers(providers);
                    break;
                case "enable":
                    await enableServer(argv.enable || argv._[1] || undefined, providers, { provider: argv.provider });
                    break;
                case "disable":
                    await disableServer(argv.disable || argv._[1] || undefined, providers, { provider: argv.provider });
                    break;
                case "install": {
                    const serverName = argv.install || argv._[1] || "";
                    const commandString = argv._[2] || "";
                    await installServer(serverName, commandString, providers, {
                        type: argv.type,
                        headers: argv.headers,
                        env: argv.env,
                        provider: argv.provider,
                    });
                    break;
                }
                case "show":
                    await showServerConfig(argv.show || argv._[1] || "", providers);
                    break;
                case "backup-all":
                case "backupAll":
                    await backupAllConfigs(providers);
                    break;
                case "rename": {
                    const oldName = argv.rename || argv._[1] || undefined;
                    const newName = argv._[2] || undefined;
                    await renameServer(oldName, newName, providers);
                    break;
                }
                default:
                    logger.error(`Unknown command: ${command}`);
                    showHelp();
                    process.exit(1);
            }
        }
    } catch (error: any) {
        logger.error(`✖ Error: ${error.message}`);
        if (argv.verbose) {
            logger.error(error.stack);
        }
        process.exit(1);
    }
}

// Run the tool
main().catch((err) => {
    logger.error(`\n✖ Unexpected error: ${err}`);
    process.exit(1);
});
