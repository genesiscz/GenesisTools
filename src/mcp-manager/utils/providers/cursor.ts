import { MCPProvider } from "./types.js";
import type { UnifiedMCPServerConfig, MCPServerInfo } from "./types.js";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import logger from "@app/logger";
import chalk from "chalk";

/**
 * Cursor MCP provider.
 * Manages MCP servers in workspace-specific storage.
 * Note: Cursor uses workspace storage, so this is a simplified implementation.
 */
interface CursorGenericConfig {
    mcpServers?: Record<string, CursorMCPServerConfig>;
    [key: string]: unknown;
}

interface CursorMCPServerConfig {
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    [key: string]: unknown;
}

export class CursorProvider extends MCPProvider {
    constructor() {
        // Cursor uses workspace storage, but we'll use a global config location
        // In practice, this might need to be workspace-specific
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
        super(path.join(homeDir, ".cursor", "mcp.json"), "cursor");
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    async readConfig(): Promise<CursorGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return JSON.parse(content) as CursorGenericConfig;
    }

    async writeConfig(config: unknown): Promise<void> {
        // Read old content for backup and diff
        let oldContent = "";
        let backupPath = "";
        if (await this.configExists()) {
            oldContent = await readFile(this.configPath, "utf-8");
            // Create backup
            backupPath = await this.backupManager.createBackup(this.configPath, this.providerName);
            if (backupPath) {
                logger.info(`Backup created: ${backupPath}`);
            }
        }

        const newContent = JSON.stringify(config, null, 2);

        // Show diff if there are changes and ask for confirmation
        if (oldContent) {
            this.backupManager.showDiff(oldContent, newContent, this.configPath);
            const confirmed = await this.backupManager.askConfirmation();

            if (!confirmed) {
                // Restore from backup if user rejected changes
                if (backupPath) {
                    await this.backupManager.restoreFromBackup(this.configPath, backupPath);
                }
                logger.info(chalk.yellow("Changes reverted."));
                return;
            }
        }

        await writeFile(this.configPath, newContent, "utf-8");
        logger.info(chalk.green(`✓ Configuration written to ${this.configPath}`));
    }

    async listServers(): Promise<MCPServerInfo[]> {
        const config = await this.readConfig();
        const servers: MCPServerInfo[] = [];

        // Cursor doesn't have explicit enable/disable, so all servers are enabled
        if (config.mcpServers) {
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                servers.push({
                    name,
                    config: this.cursorToUnified(serverConfig),
                    enabled: true,
                    provider: this.providerName,
                });
            }
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const config = await this.readConfig();
        const serverConfig = config.mcpServers?.[serverName];
        return serverConfig ? this.cursorToUnified(serverConfig) : null;
    }

    async enableServer(serverName: string): Promise<void> {
        // Cursor doesn't have explicit enable/disable
        // Servers are enabled if they exist in config
        const config = await this.readConfig();
        if (!config.mcpServers?.[serverName]) {
            throw new Error(`Server ${serverName} does not exist. Use installServer to add it.`);
        }
    }

    async disableServer(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Remove the server from config (Cursor doesn't have explicit disable)
        if (config.mcpServers?.[serverName]) {
            delete config.mcpServers[serverName];
            await this.writeConfig(config);
        }
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        // Same as disableServer for Cursor
        await this.disableServer(serverName);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void> {
        const cursorConfig = await this.readConfig();

        if (!cursorConfig.mcpServers) {
            cursorConfig.mcpServers = {};
        }

        cursorConfig.mcpServers[serverName] = this.unifiedToCursor(config);

        await this.writeConfig(cursorConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Add/update enabled servers
        for (const [name, serverConfig] of Object.entries(servers)) {
            if (serverConfig.enabled !== false && serverConfig.disabled !== true) {
                config.mcpServers[name] = this.unifiedToCursor(serverConfig);
            } else {
                // Remove disabled servers
                delete config.mcpServers[name];
            }
        }

        await this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const cursorConfig = config as CursorGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (cursorConfig.mcpServers) {
            for (const [name, serverConfig] of Object.entries(cursorConfig.mcpServers)) {
                result[name] = {
                    ...this.cursorToUnified(serverConfig),
                    enabled: true, // Cursor doesn't have disable, so all are enabled
                };
            }
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: CursorGenericConfig = {
            mcpServers: {},
        };

        // Only include enabled servers
        for (const [name, unified] of Object.entries(servers)) {
            if (unified.enabled !== false && unified.disabled !== true) {
                config.mcpServers![name] = this.unifiedToCursor(unified);
            }
        }

        return config;
    }

    private cursorToUnified(cursor: CursorMCPServerConfig): UnifiedMCPServerConfig {
        return {
            type: "stdio",
            command: cursor.command,
            args: cursor.args,
            env: cursor.env,
        };
    }

    private unifiedToCursor(unified: UnifiedMCPServerConfig): CursorMCPServerConfig {
        return {
            command: unified.command,
            args: unified.args,
            env: unified.env,
        };
    }
}
