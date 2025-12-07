import { MCPProvider } from "./types.js";
import type { UnifiedMCPServerConfig, MCPServerInfo } from "./types.js";
import type { GeminiGenericConfig, GeminiMCPServerConfig } from "./gemini.types.js";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import logger from "@app/logger";
import chalk from "chalk";
import { stripMeta } from "../config.utils.js";

/**
 * Gemini Code Assist MCP provider.
 * Manages MCP servers in ~/.gemini/settings.json
 */

export class GeminiProvider extends MCPProvider {
    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
        super(path.join(homeDir, ".gemini", "settings.json"), "gemini");
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    async readConfig(): Promise<GeminiGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return JSON.parse(content) as GeminiGenericConfig;
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
            const hasDiff = await this.backupManager.showDiff(oldContent, newContent, this.configPath);
            if (hasDiff) {
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
        }

        await writeFile(this.configPath, newContent, "utf-8");
        logger.info(chalk.green(`✓ Configuration written to ${this.configPath}`));
    }

    async listServers(): Promise<MCPServerInfo[]> {
        const config = await this.readConfig();
        const servers: MCPServerInfo[] = [];

        if (config.mcpServers) {
            const excluded = new Set(config.mcp?.excluded || []);
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                const isDisabled = excluded.has(name);
                servers.push({
                    name,
                    config: this.geminiToUnified(serverConfig),
                    enabled: !isDisabled,
                    provider: this.providerName,
                });
            }
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const config = await this.readConfig();
        const serverConfig = config.mcpServers?.[serverName];
        return serverConfig ? this.geminiToUnified(serverConfig) : null;
    }

    async enableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        // Remove from excluded list
        if (config.mcp?.excluded) {
            config.mcp.excluded = config.mcp.excluded.filter((name) => name !== serverName);
        }

        await this.writeConfig(config);
    }

    async disableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        // Add to excluded list
        if (!config.mcp) {
            config.mcp = {};
        }
        if (!config.mcp.excluded) {
            config.mcp.excluded = [];
        }
        if (!config.mcp.excluded.includes(serverName)) {
            config.mcp.excluded.push(serverName);
        }

        await this.writeConfig(config);
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        // Gemini doesn't have project-specific configs, so same as disableServer
        await this.disableServer(serverName);
    }

    async enableServers(serverNames: string[], _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        // Remove from excluded list
        if (config.mcp?.excluded) {
            config.mcp.excluded = config.mcp.excluded.filter((name) => !serverNames.includes(name));
        }

        await this.writeConfig(config);
    }

    async disableServers(serverNames: string[], _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        // Add to excluded list
        if (!config.mcp) {
            config.mcp = {};
        }
        if (!config.mcp.excluded) {
            config.mcp.excluded = [];
        }
        for (const serverName of serverNames) {
            if (!config.mcp.excluded.includes(serverName)) {
                config.mcp.excluded.push(serverName);
            }
        }

        await this.writeConfig(config);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);
        const geminiConfig = await this.readConfig();

        if (!geminiConfig.mcpServers) {
            geminiConfig.mcpServers = {};
        }

        geminiConfig.mcpServers[serverName] = this.unifiedToGemini(cleanConfig);

        // Ensure it's enabled by removing from excluded list
        if (geminiConfig.mcp?.excluded) {
            geminiConfig.mcp.excluded = geminiConfig.mcp.excluded.filter((name) => name !== serverName);
        }

        await this.writeConfig(geminiConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        if (!config.mcp) {
            config.mcp = {};
        }
        if (!config.mcp.excluded) {
            config.mcp.excluded = [];
        }

        // Add/update all servers
        for (const [name, serverConfig] of Object.entries(servers)) {
            // Read enabled state from _meta.enabled[providerName]
            const isEnabled = serverConfig._meta?.enabled?.gemini !== false; // default to enabled if not specified

            // Strip _meta before writing to provider config
            const cleanConfig = stripMeta(serverConfig);
            config.mcpServers[name] = this.unifiedToGemini(cleanConfig);

            // Update mcp.excluded based on _meta.enabled.gemini
            if (isEnabled) {
                config.mcp.excluded = config.mcp.excluded.filter((n) => n !== name);
            } else if (!config.mcp.excluded.includes(name)) {
                config.mcp.excluded.push(name);
            }
        }

        await this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const geminiConfig = config as GeminiGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (geminiConfig.mcpServers) {
            for (const [name, serverConfig] of Object.entries(geminiConfig.mcpServers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.geminiToUnified(serverConfig));
            }
        }

        return result;
    }

    /**
     * Check if a server is enabled in this provider's config
     */
    async isServerEnabled(serverName: string): Promise<boolean> {
        const config = await this.readConfig();
        const excluded = new Set(config.mcp?.excluded || []);
        return !excluded.has(serverName);
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: GeminiGenericConfig = {
            mcpServers: {},
            mcp: { excluded: [] },
        };

        for (const [name, unified] of Object.entries(servers)) {
            // Read enabled state from _meta.enabled[providerName]
            const isEnabled = unified._meta?.enabled?.gemini !== false;

            // Strip _meta before converting
            const cleanConfig = stripMeta(unified);
            config.mcpServers![name] = this.unifiedToGemini(cleanConfig);

            if (!isEnabled) {
                config.mcp!.excluded!.push(name);
            }
        }

        return config;
    }

    private geminiToUnified(gemini: GeminiMCPServerConfig): UnifiedMCPServerConfig {
        let type: "stdio" | "sse" | "http" = "stdio";
        if (gemini.url) {
            type = "sse";
        } else if (gemini.httpUrl) {
            type = "http";
        }

        return {
            type,
            command: gemini.command,
            args: gemini.args,
            env: gemini.env,
            url: gemini.url as string | undefined,
            httpUrl: gemini.httpUrl as string | undefined,
            headers: gemini.headers as Record<string, string> | undefined,
        };
    }

    private unifiedToGemini(unified: UnifiedMCPServerConfig): GeminiMCPServerConfig {
        return {
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url as string | undefined,
            httpUrl: unified.httpUrl as string | undefined,
            headers: unified.headers as Record<string, string> | undefined,
        };
    }
}
