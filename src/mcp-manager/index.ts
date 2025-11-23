import minimist from "minimist";
import Enquirer from "enquirer";
import chalk from "chalk";
import logger from "@app/logger";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import type { UnifiedMCPConfig, UnifiedMCPServerConfig, MCPServerInfo } from "./utils/providers/types.js";
import { ClaudeProvider } from "./utils/providers/claude.js";
import { GeminiProvider } from "./utils/providers/gemini.js";
import { CodexProvider } from "./utils/providers/codex.js";
import { CursorProvider } from "./utils/providers/cursor.js";
import { MCPProvider } from "./utils/providers/types.js";
import { BackupManager } from "./utils/backup.js";

// Define options interface
interface Options {
    config?: boolean;
    sync?: boolean;
    list?: boolean;
    enable?: string;
    disable?: string;
    disableAll?: string;
    install?: string;
    show?: string;
    verbose?: boolean;
    help?: boolean;
}

interface Args extends Options {
    _: string[];
}

// Create Enquirer instance
const prompter = new Enquirer();

// Get unified config path
function getUnifiedConfigPath(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
    return path.join(homeDir, "mcp.json");
}

// Get all available providers
function getProviders(): MCPProvider[] {
    return [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider()];
}

// Show help message
function showHelp() {
    logger.info(`
Usage: tools mcp-manager [command] [options]

Manage MCP (Model Context Protocol) servers across multiple AI assistants.

Commands:
  config                    Open/create ~/mcp.json configuration file
  sync                      Sync MCP servers from ~/mcp.json to selected providers
  list                      List all MCP servers across all providers
  enable <server>           Enable an MCP server in a provider
  disable <server>          Disable an MCP server in a provider
  disable-all <server>      Disable an MCP server for all projects (Claude)
  install <server>          Install/add an MCP server to a provider
  show <server>             Show full configuration of an MCP server

Options:
  -v, --verbose            Enable verbose logging
  -h, --help               Show this help message

Examples:
  tools mcp-manager config
  tools mcp-manager sync
  tools mcp-manager list
  tools mcp-manager enable github
  tools mcp-manager disable github
  tools mcp-manager install github
  tools mcp-manager show github
`);
}

// Read unified config
async function readUnifiedConfig(): Promise<UnifiedMCPConfig> {
    const configPath = getUnifiedConfigPath();
    if (!existsSync(configPath)) {
        return { mcpServers: {} };
    }

    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content) as UnifiedMCPConfig;
}

// Write unified config
async function writeUnifiedConfig(config: UnifiedMCPConfig): Promise<void> {
    const configPath = getUnifiedConfigPath();
    const backupManager = new BackupManager();

    // Read old content for backup and diff
    let oldContent = "";
    let backupPath = "";
    if (existsSync(configPath)) {
        oldContent = await readFile(configPath, "utf-8");
        // Create backup
        backupPath = await backupManager.createBackup(configPath, "unified");
        if (backupPath) {
            logger.info(`Backup created: ${backupPath}`);
        }
    }

    const newContent = JSON.stringify(config, null, 2);

    // Show diff if there are changes and ask for confirmation
    if (oldContent) {
        backupManager.showDiff(oldContent, newContent, configPath);
        const confirmed = await backupManager.askConfirmation();

        if (!confirmed) {
            // Restore from backup if user rejected changes
            if (backupPath) {
                await backupManager.restoreFromBackup(configPath, backupPath);
            }
            logger.info(chalk.yellow("Changes reverted."));
            return;
        }
    }

    await writeFile(configPath, newContent, "utf-8");
    logger.info(chalk.green(`✓ Configuration written to ${configPath}`));
}

// Open config file in editor
async function openConfig(): Promise<void> {
    const configPath = getUnifiedConfigPath();

    // Create default config if it doesn't exist
    if (!existsSync(configPath)) {
        const defaultConfig: UnifiedMCPConfig = {
            mcpServers: {},
        };
        await writeUnifiedConfig(defaultConfig);
        logger.info(`Created default config at ${configPath}`);
    }

    // Try to open in editor
    const editor = process.env.EDITOR || process.env.VISUAL || "nano";
    // Split editor command in case it has arguments (e.g., "code --wait")
    const editorParts = editor.split(" ");
    const proc = Bun.spawn({
        cmd: [...editorParts, configPath],
        stdio: ["ignore", "pipe", "pipe"],
    });

    await proc.exited;
    logger.info(`Config file: ${configPath}`);
}

// Sync servers to providers
async function syncServers(): Promise<void> {
    const config = await readUnifiedConfig();

    if (Object.keys(config.mcpServers).length === 0) {
        logger.warn("No servers found in ~/mcp.json. Run 'tools mcp-manager config' to add servers.");
        return;
    }

    const providers = getProviders();
    const availableProviders = providers.filter((p) => p.configExists());

    if (availableProviders.length === 0) {
        logger.warn("No provider configuration files found.");
        return;
    }

    try {
        const { selectedProviders } = (await prompter.prompt({
            type: "multiselect",
            name: "selectedProviders",
            message: "Select providers to sync to:",
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProviders: string[] };

        if (selectedProviders.length === 0) {
            logger.info("No providers selected. Cancelled.");
            return;
        }

        for (const providerName of selectedProviders) {
            const provider = providers.find((p) => p.getName() === providerName);
            if (!provider) continue;

            try {
                logger.info(`Syncing to ${providerName}...`);
                await provider.syncServers(config.mcpServers);
                logger.info(`✓ Synced to ${providerName}`);
            } catch (error: any) {
                logger.error(`✗ Failed to sync to ${providerName}: ${error.message}`);
            }
        }
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return;
        }
        throw error;
    }
}

// List all servers
async function listServers(): Promise<void> {
    const providers = getProviders();
    const allServers: MCPServerInfo[] = [];

    for (const provider of providers) {
        try {
            if (await provider.configExists()) {
                const servers = await provider.listServers();
                allServers.push(...servers);
            }
        } catch (error: any) {
            logger.warn(`Failed to read ${provider.getName()} config: ${error.message}`);
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
        serversByName.get(server.name)!.push(server);
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

// Enable server
async function enableServer(serverName: string): Promise<void> {
    const providers = getProviders();
    const availableProviders = [];

    for (const provider of providers) {
        if (await provider.configExists()) {
            const servers = await provider.listServers();
            if (servers.some((s) => s.name === serverName)) {
                availableProviders.push(provider);
            }
        }
    }

    if (availableProviders.length === 0) {
        logger.warn(`Server '${serverName}' not found in any provider.`);
        return;
    }

    try {
        const { selectedProvider } = (await prompter.prompt({
            type: "select",
            name: "selectedProvider",
            message: "Select provider:",
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProvider: string };

        const provider = availableProviders.find((p) => p.getName() === selectedProvider);
        if (!provider) return;

        await provider.enableServer(serverName);
        logger.info(`✓ Enabled '${serverName}' in ${selectedProvider}`);
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return;
        }
        throw error;
    }
}

// Disable server
async function disableServer(serverName: string): Promise<void> {
    const providers = getProviders();
    const availableProviders = [];

    for (const provider of providers) {
        if (await provider.configExists()) {
            const servers = await provider.listServers();
            if (servers.some((s) => s.name === serverName)) {
                availableProviders.push(provider);
            }
        }
    }

    if (availableProviders.length === 0) {
        logger.warn(`Server '${serverName}' not found in any provider.`);
        return;
    }

    try {
        const { selectedProvider } = (await prompter.prompt({
            type: "select",
            name: "selectedProvider",
            message: "Select provider:",
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProvider: string };

        const provider = availableProviders.find((p) => p.getName() === selectedProvider);
        if (!provider) return;

        await provider.disableServer(serverName);
        logger.info(`✓ Disabled '${serverName}' in ${selectedProvider}`);
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return;
        }
        throw error;
    }
}

// Disable server for all projects
async function disableServerForAllProjects(serverName: string): Promise<void> {
    const providers = getProviders();
    const claudeProvider = providers.find((p) => p.getName() === "claude") as ClaudeProvider | undefined;

    if (!claudeProvider || !(await claudeProvider.configExists())) {
        logger.warn("Claude provider not found or not configured.");
        return;
    }

    await claudeProvider.disableServerForAllProjects(serverName);
    logger.info(`✓ Disabled '${serverName}' for all projects in Claude`);
}

// Install server
async function installServer(serverName: string): Promise<void> {
    const config = await readUnifiedConfig();
    const serverConfig = config.mcpServers[serverName];

    if (!serverConfig) {
        logger.warn(`Server '${serverName}' not found in ~/mcp.json. Run 'tools mcp-manager config' to add it.`);
        return;
    }

    const providers = getProviders();
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

        await provider.installServer(serverName, serverConfig);
        logger.info(`✓ Installed '${serverName}' to ${selectedProvider}`);
    } catch (error: any) {
        if (error.message === "canceled") {
            logger.info("\nOperation cancelled by user.");
            return;
        }
        throw error;
    }
}

// Show server config
async function showServerConfig(serverName: string): Promise<void> {
    const providers = getProviders();
    const configs: Array<{ provider: string; config: UnifiedMCPServerConfig | null }> = [];

    for (const provider of providers) {
        if (await provider.configExists()) {
            const config = await provider.getServerConfig(serverName);
            if (config) {
                configs.push({ provider: provider.getName(), config });
            }
        }
    }

    if (configs.length === 0) {
        logger.warn(`Server '${serverName}' not found in any provider.`);
        return;
    }

    logger.info(`\nConfiguration for '${serverName}':\n`);
    for (const { provider, config } of configs) {
        logger.info(`${chalk.bold(provider)}:`);
        logger.info(JSON.stringify(config, null, 2));
        logger.info("");
    }
}

// Main function
async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            v: "verbose",
            h: "help",
        },
        boolean: ["verbose", "help", "config", "sync", "list"],
        string: ["enable", "disable", "disableAll", "install", "show"],
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    try {
        const command = argv._[0] || (argv.config ? "config" : argv.sync ? "sync" : argv.list ? "list" : null);

        if (!command) {
            // Interactive mode
            try {
                const { action } = (await prompter.prompt({
                    type: "select",
                    name: "action",
                    message: "What would you like to do?",
                    choices: [
                        { name: "config", message: "Open/edit ~/mcp.json configuration" },
                        { name: "sync", message: "Sync servers to providers" },
                        { name: "list", message: "List all servers" },
                        { name: "enable", message: "Enable a server" },
                        { name: "disable", message: "Disable a server" },
                        { name: "disableAll", message: "Disable server for all projects (Claude)" },
                        { name: "install", message: "Install a server" },
                        { name: "show", message: "Show server configuration" },
                    ],
                })) as { action: string };

                switch (action) {
                    case "config":
                        await openConfig();
                        break;
                    case "sync":
                        await syncServers();
                        break;
                    case "list":
                        await listServers();
                        break;
                    case "enable": {
                        const { serverName } = (await prompter.prompt({
                            type: "input",
                            name: "serverName",
                            message: "Server name:",
                        })) as { serverName: string };
                        await enableServer(serverName);
                        break;
                    }
                    case "disable": {
                        const { serverName } = (await prompter.prompt({
                            type: "input",
                            name: "serverName",
                            message: "Server name:",
                        })) as { serverName: string };
                        await disableServer(serverName);
                        break;
                    }
                    case "disableAll": {
                        const { serverName } = (await prompter.prompt({
                            type: "input",
                            name: "serverName",
                            message: "Server name:",
                        })) as { serverName: string };
                        await disableServerForAllProjects(serverName);
                        break;
                    }
                    case "install": {
                        const { serverName } = (await prompter.prompt({
                            type: "input",
                            name: "serverName",
                            message: "Server name:",
                        })) as { serverName: string };
                        await installServer(serverName);
                        break;
                    }
                    case "show": {
                        const { serverName } = (await prompter.prompt({
                            type: "input",
                            name: "serverName",
                            message: "Server name:",
                        })) as { serverName: string };
                        await showServerConfig(serverName);
                        break;
                    }
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
                    await openConfig();
                    break;
                case "sync":
                    await syncServers();
                    break;
                case "list":
                    await listServers();
                    break;
                case "enable":
                    await enableServer(argv.enable || argv._[1] || "");
                    break;
                case "disable":
                    await disableServer(argv.disable || argv._[1] || "");
                    break;
                case "disable-all":
                case "disableAll":
                    await disableServerForAllProjects(argv.disableAll || argv._[1] || "");
                    break;
                case "install":
                    await installServer(argv.install || argv._[1] || "");
                    break;
                case "show":
                    await showServerConfig(argv.show || argv._[1] || "");
                    break;
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
