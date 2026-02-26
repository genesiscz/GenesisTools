import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import logger from "@app/logger";
import { stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import chalk from "chalk";
import type { CursorGenericConfig, CursorMCPServerConfig } from "./cursor.types.js";
import type { MCPServerInfo, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, WriteResult } from "./types.js";

/**
 * Cursor MCP provider.
 * Manages MCP servers in workspace-specific storage.
 * Note: Cursor uses workspace storage, so this is a simplified implementation.
 */

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

    supportsDisabledState(): boolean {
        return false; // Cursor: presence in config = enabled
    }

    async readConfig(): Promise<CursorGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return JSON.parse(content) as CursorGenericConfig;
    }

    async writeConfig(config: unknown): Promise<WriteResult> {
        const newContent = JSON.stringify(config, null, 2);

        // Read old content (empty string if file doesn't exist)
        const oldContent = (await this.configExists()) ? await readFile(this.configPath, "utf-8") : "";

        // Early exit if no changes
        if (oldContent === newContent) {
            return WriteResult.NoChanges;
        }

        // Show diff and ask for confirmation
        await this.backupManager.showDiff(oldContent, newContent, this.configPath);
        const confirmed = await this.backupManager.askConfirmation();

        if (!confirmed) {
            return WriteResult.Rejected;
        }

        // Only now write to file (with backup)
        await this.writeFileWithBackup(newContent);
        logger.info(chalk.green(`✓ Configuration written to ${this.configPath}`));
        return WriteResult.Applied;
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

    async enableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        // Cursor doesn't have explicit enable/disable
        // Servers are enabled if they exist in config
        const config = await this.readConfig();
        if (!config.mcpServers?.[serverName]) {
            throw new Error(`Server ${serverName} does not exist. Use installServer to add it.`);
        }
    }

    async disableServer(serverName: string, _projectPath?: string | null): Promise<void> {
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

    async enableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        // Cursor doesn't have explicit enable/disable
        // Servers are enabled if they exist in config - this is a no-op
        const config = await this.readConfig();
        const missing = serverNames.filter((name) => !config.mcpServers?.[name]);
        if (missing.length > 0) {
            throw new Error(`Servers do not exist: ${missing.join(", ")}. Use installServer to add them.`);
        }
        return WriteResult.NoChanges;
    }

    async disableServers(serverNames: string[], _projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        let changed = false;
        for (const serverName of serverNames) {
            if (config.mcpServers?.[serverName]) {
                delete config.mcpServers[serverName];
                changed = true;
            }
        }

        if (changed) {
            return this.writeConfig(config);
        }
        return WriteResult.NoChanges;
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);
        const cursorConfig = await this.readConfig();

        if (!cursorConfig.mcpServers) {
            cursorConfig.mcpServers = {};
        }

        cursorConfig.mcpServers[serverName] = this.unifiedToCursor(cleanConfig);

        return this.writeConfig(cursorConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        for (const [name, serverConfig] of Object.entries(servers)) {
            const isEnabled = this.isServerEnabledInMeta(serverConfig);

            if (isEnabled) {
                const cleanConfig = stripMeta(serverConfig);
                config.mcpServers[name] = this.unifiedToCursor(cleanConfig);
            } else {
                delete config.mcpServers[name];
            }
        }

        return this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const cursorConfig = config as CursorGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (cursorConfig.mcpServers) {
            for (const [name, serverConfig] of Object.entries(cursorConfig.mcpServers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.cursorToUnified(serverConfig));
            }
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: CursorGenericConfig = {
            mcpServers: {},
        };

        for (const [name, unified] of Object.entries(servers)) {
            // Read enabled state using utility method
            const isEnabled = this.isServerEnabledInMeta(unified);

            // Cursor doesn't have native disable - only include if enabled
            if (isEnabled) {
                const cleanConfig = stripMeta(unified);
                config.mcpServers![name] = this.unifiedToCursor(cleanConfig);
            }
        }

        return config;
    }

    private cursorToUnified(cursor: CursorMCPServerConfig): UnifiedMCPServerConfig {
        let type: "stdio" | "sse" | "http" = (cursor.type as "stdio" | "sse" | "http") || "stdio";
        if (cursor.url && !cursor.command) {
            type = "sse";
        }

        return {
            type,
            command: cursor.command,
            args: cursor.args,
            env: cursor.env,
            url: cursor.url as string | undefined,
            headers: cursor.headers as Record<string, string> | undefined,
        };
    }

    private unifiedToCursor(unified: UnifiedMCPServerConfig): CursorMCPServerConfig {
        return {
            type: unified.type || "stdio",
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url,
            headers: unified.headers,
        };
    }
}
