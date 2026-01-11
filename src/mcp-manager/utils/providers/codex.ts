import { MCPProvider } from "./types.js";
import type { UnifiedMCPServerConfig, MCPServerInfo } from "./types.js";
import type { CodexGenericConfig, CodexMCPServerConfig } from "./codex.types.js";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import * as TOML from "@iarna/toml";
import logger from "@app/logger";
import chalk from "chalk";
import { stripMeta } from "../config.utils.js";

/**
 * Codex MCP provider.
 * Manages MCP servers in ~/.codex/config.toml
 */

export class CodexProvider extends MCPProvider {
    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
        super(path.join(homeDir, ".codex", "config.toml"), "codex");
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    async readConfig(): Promise<CodexGenericConfig> {
        if (!(await this.configExists())) {
            return { mcp_servers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return TOML.parse(content) as CodexGenericConfig;
    }

    async writeConfig(config: unknown): Promise<void> {
        // Ensure directory exists
        const dir = path.dirname(this.configPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

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

        const newContent = TOML.stringify(config as Record<string, any>);

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

        // Codex doesn't have explicit enable/disable, so all servers are enabled
        if (config.mcp_servers) {
            for (const [name, serverConfig] of Object.entries(config.mcp_servers)) {
                servers.push({
                    name,
                    config: this.codexToUnified(serverConfig),
                    enabled: true,
                    provider: this.providerName,
                });
            }
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const config = await this.readConfig();
        const serverConfig = config.mcp_servers?.[serverName];
        return serverConfig ? this.codexToUnified(serverConfig) : null;
    }

    async enableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        // Codex doesn't have explicit enable/disable
        // Servers are enabled if they exist in config
        // This is a no-op, but we ensure the server exists
        const config = await this.readConfig();
        if (!config.mcp_servers?.[serverName]) {
            throw new Error(`Server ${serverName} does not exist. Use installServer to add it.`);
        }
    }

    async disableServer(serverName: string, _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        // Remove the server from config (Codex doesn't have explicit disable)
        if (config.mcp_servers?.[serverName]) {
            delete config.mcp_servers[serverName];
            await this.writeConfig(config);
        }
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        // Same as disableServer for Codex
        await this.disableServer(serverName);
    }

    async enableServers(serverNames: string[], _projectPath?: string | null): Promise<void> {
        // Codex doesn't have explicit enable/disable
        // Servers are enabled if they exist in config - this is a no-op
        const config = await this.readConfig();
        const missing = serverNames.filter((name) => !config.mcp_servers?.[name]);
        if (missing.length > 0) {
            throw new Error(`Servers do not exist: ${missing.join(", ")}. Use installServer to add them.`);
        }
    }

    async disableServers(serverNames: string[], _projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        // Remove servers from config (Codex doesn't have explicit disable)
        let changed = false;
        for (const serverName of serverNames) {
            if (config.mcp_servers?.[serverName]) {
                delete config.mcp_servers[serverName];
                changed = true;
            }
        }

        if (changed) {
            await this.writeConfig(config);
        }
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);
        const codexConfig = await this.readConfig();

        if (!codexConfig.mcp_servers) {
            codexConfig.mcp_servers = {};
        }

        codexConfig.mcp_servers[serverName] = this.unifiedToCodex(cleanConfig);

        await this.writeConfig(codexConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void> {
        const config = await this.readConfig();

        if (!config.mcp_servers) {
            config.mcp_servers = {};
        }

        // Add/update all servers
        for (const [name, serverConfig] of Object.entries(servers)) {
            // Read enabled state using utility method
            const isEnabled = this.isServerEnabledInMeta(serverConfig);

            // Codex doesn't have native disable - only add if enabled, remove if disabled
            if (isEnabled) {
                const cleanConfig = stripMeta(serverConfig);
                config.mcp_servers[name] = this.unifiedToCodex(cleanConfig);
            } else {
                delete config.mcp_servers[name];
            }
        }

        await this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const codexConfig = config as CodexGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (codexConfig.mcp_servers) {
            for (const [name, serverConfig] of Object.entries(codexConfig.mcp_servers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.codexToUnified(serverConfig));
            }
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: CodexGenericConfig = {
            mcp_servers: {},
        };

        for (const [name, unified] of Object.entries(servers)) {
            // Read enabled state using utility method
            const isEnabled = this.isServerEnabledInMeta(unified);

            // Codex doesn't have native disable - only include if enabled
            if (isEnabled) {
                const cleanConfig = stripMeta(unified);
                config.mcp_servers![name] = this.unifiedToCodex(cleanConfig);
            }
        }

        return config;
    }

    private codexToUnified(codex: CodexMCPServerConfig): UnifiedMCPServerConfig {
        let type: "stdio" | "sse" | "http" = (codex.type as any) || "stdio";
        if (codex.url && !codex.command) {
            type = "sse";
        }

        return {
            type,
            command: codex.command,
            args: codex.args,
            env: codex.env,
            url: codex.url as string | undefined,
            headers: codex.headers as Record<string, string> | undefined,
        };
    }

    private unifiedToCodex(unified: UnifiedMCPServerConfig): CodexMCPServerConfig {
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
