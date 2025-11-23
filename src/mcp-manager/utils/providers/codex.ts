import { MCPProvider } from "./types.js";
import type { UnifiedMCPServerConfig, MCPServerInfo } from "./types.js";
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import * as TOML from "@iarna/toml";
import logger from "@app/logger";
import chalk from "chalk";

/**
 * Codex MCP provider.
 * Manages MCP servers in ~/.codex/config.toml
 */
interface CodexGenericConfig {
    model?: string;
    model_reasoning_effort?: "low" | "medium" | "high";
    show_raw_agent_reasoning?: boolean;
    mcp_servers?: Record<string, CodexMCPServerConfig>;
    projects?: Record<string, CodexProjectConfig>;
    [key: string]: unknown;
}

interface CodexMCPServerConfig {
    command?: string;
    args?: unknown[];
    env?: Record<string, string>;
    [key: string]: unknown;
}

interface CodexProjectConfig {
    trust_level?: "trusted" | "untrusted" | "unknown";
    [key: string]: unknown;
}

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

    async enableServer(serverName: string): Promise<void> {
        // Codex doesn't have explicit enable/disable
        // Servers are enabled if they exist in config
        // This is a no-op, but we ensure the server exists
        const config = await this.readConfig();
        if (!config.mcp_servers?.[serverName]) {
            throw new Error(`Server ${serverName} does not exist. Use installServer to add it.`);
        }
    }

    async disableServer(serverName: string): Promise<void> {
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

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void> {
        const codexConfig = await this.readConfig();

        if (!codexConfig.mcp_servers) {
            codexConfig.mcp_servers = {};
        }

        codexConfig.mcp_servers[serverName] = this.unifiedToCodex(config);

        await this.writeConfig(codexConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void> {
        const config = await this.readConfig();

        if (!config.mcp_servers) {
            config.mcp_servers = {};
        }

        // Add/update enabled servers
        for (const [name, serverConfig] of Object.entries(servers)) {
            if (serverConfig.enabled !== false && serverConfig.disabled !== true) {
                config.mcp_servers[name] = this.unifiedToCodex(serverConfig);
            } else {
                // Remove disabled servers
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
                result[name] = {
                    ...this.codexToUnified(serverConfig),
                    enabled: true, // Codex doesn't have disable, so all are enabled
                };
            }
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: CodexGenericConfig = {
            mcp_servers: {},
        };

        // Only include enabled servers
        for (const [name, unified] of Object.entries(servers)) {
            if (unified.enabled !== false && unified.disabled !== true) {
                config.mcp_servers![name] = this.unifiedToCodex(unified);
            }
        }

        return config;
    }

    private codexToUnified(codex: CodexMCPServerConfig): UnifiedMCPServerConfig {
        return {
            type: "stdio",
            command: codex.command,
            args: codex.args,
            env: codex.env,
        };
    }

    private unifiedToCodex(unified: UnifiedMCPServerConfig): CodexMCPServerConfig {
        return {
            command: unified.command,
            args: unified.args,
            env: unified.env,
        };
    }
}
