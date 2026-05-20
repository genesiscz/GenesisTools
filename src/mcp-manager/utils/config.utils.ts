import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { Storage } from "@app/utils/storage";
import chalk from "chalk";
import { BackupManager } from "./backup.js";
import type { UnifiedMCPConfig, UnifiedMCPServerConfig } from "./providers/types.js";
import type { EnabledMcpServers } from "./types.js";

// Lazy Storage accessor (NOT a module-level singleton): constructed per call
// so it always re-reads GENESIS_TOOLS_HOME at use time. Production behavior is
// identical (env unset → real ~/.genesis-tools path, construction is just path
// joins); this lets the test suite sandbox the path so a leaked/bled mock can
// never write the user's real config (see storage.ts override + test sandbox).
const mcpStorage = (): Storage => new Storage("mcp-manager");

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
    return mcpStorage().getConfigPath();
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
            if (!config.mcpServers[serverName]._meta?.enabled) {
                config.mcpServers[serverName]._meta!.enabled = {};
            }
            // Merge enabled state from enabledMcpServers into _meta.enabled
            config.mcpServers[serverName]._meta!.enabled = {
                ...config.mcpServers[serverName]._meta?.enabled,
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
    const storage = mcpStorage();
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
 * @returns true if changes were written, false if no changes or rejected
 */
export async function writeUnifiedConfig(config: UnifiedMCPConfig): Promise<boolean> {
    const storage = mcpStorage();
    const configPath = storage.getConfigPath();

    // Ensure enabledMcpServers is in sync with _meta.enabled before writing
    config = syncEnabledMcpServers(config);

    const newContent = SafeJSON.stringify(config, null, 2);

    // Read old content
    const existingConfig = await storage.getConfig<UnifiedMCPConfig>();
    const oldContent = existingConfig ? SafeJSON.stringify(existingConfig, null, 2) : "";

    // Early exit if no changes
    if (oldContent === newContent) {
        return false;
    }

    // Show diff and ask for confirmation
    const backupManager = new BackupManager();
    await backupManager.showDiff(oldContent, newContent, configPath);
    const confirmed = await backupManager.askConfirmation();

    if (!confirmed) {
        return false;
    }

    // Create backup before writing
    await backupManager.createBackup(configPath, "unified");

    // Only now write to file
    await storage.setConfig(config);
    logger.info(chalk.green(`✓ Configuration written to ${configPath}`));
    return true;
}
