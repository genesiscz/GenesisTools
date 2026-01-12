import { Storage } from "@app/utils/storage";
import type { UnifiedMCPConfig, UnifiedMCPServerConfig } from "./providers/types.js";
import type { EnabledMcpServers } from "./types.js";
import { BackupManager } from "./backup.js";
import { existsSync } from "fs";
import logger from "@app/logger";
import chalk from "chalk";

// Initialize Storage instance for mcp-manager
const storage = new Storage("mcp-manager");

// Global options that can be set from main entry point
export interface GlobalOptions {
    yes?: boolean; // Auto-confirm changes without prompting
}

let globalOptions: GlobalOptions = {};

export function setGlobalOptions(options: GlobalOptions): void {
    globalOptions = options;
}

export function getGlobalOptions(): GlobalOptions {
    return globalOptions;
}

/**
 * Get the path to the unified config file
 */
export function getUnifiedConfigPath(): string {
    return storage.getConfigPath();
}

/**
 * Strip _meta from a single server config.
 * _meta is not synchronized and should remain only in unified config.
 * This is the unified utility that ALL code must use when passing configs to providers.
 */
export function stripMeta(config: UnifiedMCPServerConfig): UnifiedMCPServerConfig {
    const { _meta, ...rest } = config;
    return rest;
}

/**
 * Strip _meta from server configs before syncing to providers.
 * _meta is not synchronized and should remain only in unified config.
 * Uses stripMeta internally for consistency.
 */
export function stripMetaFromServers(
    servers: Record<string, UnifiedMCPServerConfig>
): Record<string, UnifiedMCPServerConfig> {
    const stripped: Record<string, UnifiedMCPServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
        stripped[name] = stripMeta(config);
    }
    return stripped;
}

/**
 * Sync enabledMcpServers with _meta.enabled from all servers.
 * This ensures the root-level enabledMcpServers stays in sync with _meta.enabled.
 */
export function syncEnabledMcpServers(config: UnifiedMCPConfig): UnifiedMCPConfig {
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
export function ensureMetaFromEnabledMcpServers(config: UnifiedMCPConfig): UnifiedMCPConfig {
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

/**
 * Read the unified config from storage
 */
export async function readUnifiedConfig(): Promise<UnifiedMCPConfig> {
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

/**
 * Write the unified config to storage
 */
export async function writeUnifiedConfig(config: UnifiedMCPConfig): Promise<void> {
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
        const hasDiff = await backupManager.showDiff(oldContent, newContent, configPath);
        if (hasDiff) {
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
    }

    await storage.setConfig(config);
    logger.info(chalk.green(`✓ Configuration written to ${configPath}`));
}
