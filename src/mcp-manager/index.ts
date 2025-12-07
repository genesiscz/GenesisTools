import minimist from "minimist";
import Enquirer from "enquirer";
import chalk from "chalk";
import logger, { configureLogger, consoleLog } from "@app/logger";
import { existsSync } from "fs";
import path from "path";
import type { UnifiedMCPConfig, UnifiedMCPServerConfig, MCPServerInfo } from "./utils/providers/types.js";
import type { EnabledMcpServers, MCPProviderName } from "./utils/types.js";
import { ClaudeProvider } from "./utils/providers/claude.js";
import { GeminiProvider } from "./utils/providers/gemini.js";
import { CodexProvider } from "./utils/providers/codex.js";
import { CursorProvider } from "./utils/providers/cursor.js";
import { MCPProvider } from "./utils/providers/types.js";
import { BackupManager } from "./utils/backup.js";
import { Storage } from "@app/utils/storage";
import { DiffUtil } from "@app/utils/diff";

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
    sync?: boolean;
    syncFromProviders?: boolean;
    list?: boolean;
    enable?: string;
    disable?: string;
    disableAll?: string;
    install?: string;
    show?: string;
    backupAll?: boolean;
    verbose?: boolean;
    help?: boolean;
}

interface Args extends Options {
    _: string[];
}

// Create Enquirer instance
const prompter = new Enquirer();

// Initialize Storage instance for mcp-manager
const storage = new Storage("mcp-manager");

// Get unified config path (now using Storage)
function getUnifiedConfigPath(): string {
    return storage.getConfigPath();
}

// Get all available providers
function getProviders(): MCPProvider[] {
    return [new ClaudeProvider(), new GeminiProvider(), new CodexProvider(), new CursorProvider()];
}

/**
 * Strip _meta from server configs before syncing to providers.
 * _meta is not synchronized and should remain only in unified config.
 */
function stripMetaFromServers(servers: Record<string, UnifiedMCPServerConfig>): Record<string, UnifiedMCPServerConfig> {
    const stripped: Record<string, UnifiedMCPServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
        const { _meta, ...rest } = config;
        stripped[name] = rest;
    }
    return stripped;
}

/**
 * Sync enabledMcpServers with _meta.enabled from all servers.
 * This ensures the root-level enabledMcpServers stays in sync with _meta.enabled.
 */
function syncEnabledMcpServers(config: UnifiedMCPConfig): UnifiedMCPConfig {
    const enabledMcpServers: EnabledMcpServers = {};

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        if (serverConfig._meta?.enabled) {
            enabledMcpServers[serverName] = { ...serverConfig._meta.enabled };
        }
    }

    config.enabledMcpServers = enabledMcpServers;
    return config;
}

/**
 * Ensure _meta.enabled is synced from enabledMcpServers if _meta doesn't exist.
 * This handles the case where enabledMcpServers exists but _meta doesn't.
 */
function ensureMetaFromEnabledMcpServers(config: UnifiedMCPConfig): UnifiedMCPConfig {
    if (!config.enabledMcpServers) {
        return config;
    }

    for (const [serverName, enabledState] of Object.entries(config.enabledMcpServers)) {
        if (config.mcpServers[serverName]) {
            if (!config.mcpServers[serverName]._meta) {
                config.mcpServers[serverName]._meta = { enabled: {} };
            }
            if (!config.mcpServers[serverName]._meta!.enabled) {
                config.mcpServers[serverName]._meta!.enabled = {};
            }
            // Merge enabled state from enabledMcpServers into _meta.enabled
            config.mcpServers[serverName]._meta!.enabled = {
                ...config.mcpServers[serverName]._meta!.enabled,
                ...enabledState,
            };
        }
    }

    return config;
}

// Show help message
function showHelp() {
    logger.info(`
Usage: tools mcp-manager [command] [options]

Manage MCP (Model Context Protocol) servers across multiple AI assistants.

Commands:
  config                    Open/create unified configuration file
  sync                      Sync MCP servers from unified config to selected providers
  sync-from-providers       Sync servers FROM providers TO unified config
  list                      List all MCP servers across all providers
  enable <server>           Enable an MCP server in a provider
  disable <server>          Disable an MCP server in a provider
  disable-all <server>      Disable an MCP server for all projects (Claude)
  install <server>          Install/add an MCP server to a provider
  show <server>             Show full configuration of an MCP server
  backup-all                Backup all configs for all providers

Options:
  -v, --verbose            Enable verbose logging
  -h, --help               Show this help message

Examples:
  tools mcp-manager config
  tools mcp-manager sync
  tools mcp-manager sync-from-providers
  tools mcp-manager list
  tools mcp-manager enable github
  tools mcp-manager disable github
  tools mcp-manager install github
  tools mcp-manager show github
  tools mcp-manager backup-all
`);
}

// Read unified config
async function readUnifiedConfig(): Promise<UnifiedMCPConfig> {
    await storage.ensureDirs();
    let config = await storage.getConfig<UnifiedMCPConfig>();
    if (!config) {
        config = { mcpServers: {} };
    }

    // Ensure _meta.enabled is synced from enabledMcpServers if needed
    config = ensureMetaFromEnabledMcpServers(config);

    // Ensure enabledMcpServers is in sync with _meta.enabled
    config = syncEnabledMcpServers(config);

    return config;
}

// Write unified config
async function writeUnifiedConfig(config: UnifiedMCPConfig): Promise<void> {
    const configPath = getUnifiedConfigPath();
    const backupManager = new BackupManager();

    // Ensure enabledMcpServers is in sync with _meta.enabled before writing
    config = syncEnabledMcpServers(config);

    // Read old content for backup and diff
    let oldContent = "";
    let backupPath = "";
    const existingConfig = await storage.getConfig<UnifiedMCPConfig>();
    if (existingConfig) {
        oldContent = JSON.stringify(existingConfig, null, 2);
        // Create backup
        backupPath = await backupManager.createBackup(configPath, "unified");
        if (backupPath) {
            logger.info(`Backup created: ${backupPath}`);
        }
    }

    const newContent = JSON.stringify(config, null, 2);

    // Show diff if there are changes and ask for confirmation
    if (oldContent) {
        await backupManager.showDiff(oldContent, newContent, configPath);
        const confirmed = await backupManager.askConfirmation();

        if (!confirmed) {
            // Restore from backup if user rejected changes
            if (backupPath && existsSync(backupPath)) {
                await backupManager.restoreFromBackup(configPath, backupPath);
            }
            logger.info(chalk.yellow("Changes reverted."));
            return;
        }
    }

    await storage.setConfig(config);
    logger.info(chalk.green(`✓ Configuration written to ${configPath}`));
}

// Open config file in editor
async function openConfig(): Promise<void> {
    await storage.ensureDirs();
    const configPath = getUnifiedConfigPath();

    // Create default config if it doesn't exist
    const existingConfig = await storage.getConfig<UnifiedMCPConfig>();
    if (!existingConfig) {
        const defaultConfig: UnifiedMCPConfig = {
            mcpServers: {},
        };
        await storage.setConfig(defaultConfig);
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
        logger.warn("No servers found in unified config. Run 'tools mcp-manager config' to add servers.");
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

        // Strip _meta from servers before syncing (_meta is not synchronized)
        const serversToSync = stripMetaFromServers(config.mcpServers);

        for (const providerName of selectedProviders) {
            const provider = providers.find((p) => p.getName() === providerName);
            if (!provider) continue;

            try {
                logger.info(`Syncing to ${providerName}...`);
                await provider.syncServers(serversToSync);
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

// Sync servers FROM providers TO unified config
async function syncFromProviders(): Promise<void> {
    const providers = getProviders();
    const availableProviders: MCPProvider[] = [];

    // Check which providers have configs
    for (const provider of providers) {
        if (await provider.configExists()) {
            availableProviders.push(provider);
        }
    }

    if (availableProviders.length === 0) {
        logger.warn("No provider configuration files found.");
        return;
    }

    try {
        const { selectedProviders } = (await prompter.prompt({
            type: "multiselect",
            name: "selectedProviders",
            message: "Select providers to sync from:",
            choices: availableProviders.map((p) => ({
                name: p.getName(),
                message: `${p.getName()} (${p.getConfigPath()})`,
            })),
        })) as { selectedProviders: string[] };

        if (selectedProviders.length === 0) {
            logger.info("No providers selected. Cancelled.");
            return;
        }

        // Read current unified config
        const unifiedConfig = await readUnifiedConfig();
        // Preserve _meta from existing config when merging
        const mergedServers: Record<string, UnifiedMCPServerConfig> = {};
        for (const [name, config] of Object.entries(unifiedConfig.mcpServers)) {
            mergedServers[name] = { ...config };
        }

        // Track conflicts: serverName -> { existing: config, incoming: config, provider: string }
        const conflicts: Map<
            string,
            {
                existing: UnifiedMCPServerConfig;
                incoming: UnifiedMCPServerConfig;
                provider: string;
            }
        > = new Map();

        // Import servers from each selected provider
        for (const providerName of selectedProviders) {
            const provider = availableProviders.find((p) => p.getName() === providerName);
            if (!provider) continue;

            try {
                logger.info(`Reading servers from ${providerName}...`);
                const providerConfig = await provider.readConfig();
                const providerServers = provider.toUnifiedConfig(providerConfig);

                // Check for conflicts before merging
                for (const [serverName, serverConfig] of Object.entries(providerServers)) {
                    const existingConfig = mergedServers[serverName];

                    if (existingConfig) {
                        // Preserve _meta from existing config
                        const preservedMeta = existingConfig._meta;

                        // Check if there's a conflict in args, env, or other critical fields
                        // Note: "name" is the server key, so we check args and env as specified
                        const conflictCheck = DiffUtil.detectConflicts(
                            existingConfig as Record<string, unknown>,
                            serverConfig as Record<string, unknown>,
                            ["command", "args", "env", "url", "type"]
                        );

                        if (conflictCheck.hasConflict) {
                            // Store conflict for later resolution (preserve _meta)
                            conflicts.set(serverName, {
                                existing: existingConfig,
                                incoming: { ...serverConfig, _meta: preservedMeta },
                                provider: providerName,
                            });
                            logger.warn(
                                chalk.yellow(
                                    `⚠ Conflict detected for '${serverName}': differences in ${conflictCheck.differences.join(
                                        ", "
                                    )}`
                                )
                            );
                        } else {
                            // No conflict, safe to merge (preserve _meta)
                            mergedServers[serverName] = { ...serverConfig, _meta: preservedMeta };
                            logger.debug(`  Imported: ${serverName}`);
                        }
                    } else {
                        // New server, no conflict (no _meta to preserve)
                        mergedServers[serverName] = serverConfig;
                        logger.debug(`  Imported: ${serverName}`);
                    }
                }

                logger.info(`✓ Imported ${Object.keys(providerServers).length} server(s) from ${providerName}`);
            } catch (error: any) {
                logger.error(`✗ Failed to read from ${providerName}: ${error.message}`);
            }
        }

        // Resolve conflicts if any
        if (conflicts.size > 0) {
            logger.info(chalk.yellow(`\n⚠ Found ${conflicts.size} conflict(s) that need resolution:\n`));

            for (const [serverName, conflict] of conflicts.entries()) {
                logger.info(chalk.bold(`\nConflict for server: ${chalk.cyan(serverName)}`));
                logger.info(`Provider: ${chalk.magenta(conflict.provider)}\n`);

                // Show diff
                const existingJson = JSON.stringify(conflict.existing, null, 2);
                const incomingJson = JSON.stringify(conflict.incoming, null, 2);

                await DiffUtil.showDiff(
                    existingJson,
                    incomingJson,
                    "Current (unified config)",
                    `Incoming (${conflict.provider})`
                );

                // Ask user to choose
                try {
                    const { choice } = (await prompter.prompt({
                        type: "select",
                        name: "choice",
                        message: `Which version should be kept for '${serverName}'?`,
                        choices: [
                            {
                                name: "current",
                                message: `Keep current (unified config)`,
                            },
                            {
                                name: "incoming",
                                message: `Use incoming (${conflict.provider})`,
                            },
                        ],
                    })) as { choice: string };

                    if (choice === "incoming") {
                        // Preserve _meta when using incoming version
                        const preservedMeta = mergedServers[serverName]?._meta;
                        mergedServers[serverName] = { ...conflict.incoming, _meta: preservedMeta };
                        logger.info(chalk.green(`✓ Using incoming version from ${conflict.provider}`));
                    } else {
                        logger.info(chalk.green(`✓ Keeping current version`));
                    }
                } catch (error: any) {
                    if (error.message === "canceled") {
                        logger.info("\nOperation cancelled by user.");
                        return;
                    }
                    throw error;
                }
            }
        }

        // Update unified config with merged servers
        unifiedConfig.mcpServers = mergedServers;
        // Sync enabledMcpServers with _meta.enabled before writing
        await writeUnifiedConfig(unifiedConfig);

        logger.info(
            chalk.green(`✓ Successfully synced ${Object.keys(mergedServers).length} server(s) to unified config`)
        );
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

        // Update _meta.enabled in unified config
        const config = await readUnifiedConfig();
        if (!config.mcpServers[serverName]) {
            config.mcpServers[serverName] = {};
        }
        if (!config.mcpServers[serverName]._meta) {
            config.mcpServers[serverName]._meta = { enabled: {} };
        }
        if (!config.mcpServers[serverName]._meta!.enabled) {
            config.mcpServers[serverName]._meta!.enabled = {};
        }
        config.mcpServers[serverName]._meta!.enabled[selectedProvider as MCPProviderName] = true;
        await writeUnifiedConfig(config);

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

        // Update _meta.enabled in unified config
        const config = await readUnifiedConfig();
        if (config.mcpServers[serverName]) {
            if (!config.mcpServers[serverName]._meta) {
                config.mcpServers[serverName]._meta = { enabled: {} };
            }
            if (!config.mcpServers[serverName]._meta!.enabled) {
                config.mcpServers[serverName]._meta!.enabled = {};
            }
            config.mcpServers[serverName]._meta!.enabled[selectedProvider as MCPProviderName] = false;
            await writeUnifiedConfig(config);
        }

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
        logger.warn(`Server '${serverName}' not found in unified config. Run 'tools mcp-manager config' to add it.`);
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

    consoleLog.info(`\nConfiguration for '${serverName}':\n`);
    for (const { provider, config } of configs) {
        consoleLog.info(`${chalk.bold(provider)}:`);
        consoleLog.info(JSON.stringify(config, null, 2));
        consoleLog.info("");
    }
}

// Backup all configs
async function backupAllConfigs(): Promise<void> {
    const providers = getProviders();
    const backupManager = new BackupManager();
    const backupMap: Map<string, string> = new Map();

    logger.info("Creating backups for all provider configs...\n");

    // Backup unified config if it exists
    const unifiedConfigPath = getUnifiedConfigPath();
    if (existsSync(unifiedConfigPath)) {
        const unifiedBackupPath = await backupManager.createBackup(unifiedConfigPath, "unified");
        if (unifiedBackupPath) {
            const absoluteOriginal = path.resolve(unifiedConfigPath);
            const absoluteBackup = path.resolve(unifiedBackupPath);
            backupMap.set(absoluteOriginal, absoluteBackup);
            logger.info(chalk.green(`✓ Backed up unified config: ${absoluteBackup}`));
        }
    }

    // Backup all provider configs
    for (const provider of providers) {
        if (await provider.configExists()) {
            const configPath = provider.getConfigPath();
            const providerName = provider.getName();
            const backupPath = await backupManager.createBackup(configPath, providerName);

            if (backupPath) {
                const absoluteOriginal = path.resolve(configPath);
                const absoluteBackup = path.resolve(backupPath);
                backupMap.set(absoluteOriginal, absoluteBackup);
                logger.info(chalk.green(`✓ Backed up ${providerName}: ${absoluteBackup}`));
            }
        } else {
            logger.debug(`Skipping ${provider.getName()} (config does not exist)`);
        }
    }

    if (backupMap.size === 0) {
        logger.warn("No configs found to backup.");
        return;
    }

    // Log the map of original files to backup paths
    logger.info(chalk.bold("\nBackup Summary:\n"));
    logger.info("Original file → Backup file:");
    for (const [original, backup] of backupMap.entries()) {
        logger.info(`  ${chalk.cyan(original)}`);
        logger.info(`    → ${chalk.green(backup)}`);
    }
    logger.info(`\n✓ Successfully backed up ${backupMap.size} config file(s)`);
}

// Main function
async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            v: "verbose",
            h: "help",
        },
        boolean: ["verbose", "help", "config", "sync", "syncFromProviders", "list", "backupAll"],
        string: ["enable", "disable", "disableAll", "install", "show"],
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
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
                        { name: "enable", message: "Enable a server" },
                        { name: "disable", message: "Disable a server" },
                        { name: "disableAll", message: "Disable server for all projects (Claude)" },
                        { name: "install", message: "Install a server" },
                        { name: "show", message: "Show server configuration" },
                        { name: "backupAll", message: "Backup all configs" },
                    ],
                })) as { action: string };

                switch (action) {
                    case "config":
                        await openConfig();
                        break;
                    case "sync":
                        await syncServers();
                        break;
                    case "syncFromProviders":
                        await syncFromProviders();
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
                    case "backupAll":
                        await backupAllConfigs();
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
                    await openConfig();
                    break;
                case "sync":
                    await syncServers();
                    break;
                case "sync-from-providers":
                case "syncFromProviders":
                    await syncFromProviders();
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
                case "backup-all":
                case "backupAll":
                    await backupAllConfigs();
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
