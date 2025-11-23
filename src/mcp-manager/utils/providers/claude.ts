import { MCPProvider } from "./types.js";
import type { UnifiedMCPServerConfig, MCPServerInfo } from "./types.js";
import type { ClaudeGenericConfig, ClaudeMCPServerConfig } from "../../../../claude.generic.js";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import logger from "@app/logger";
import chalk from "chalk";

/**
 * Claude Desktop MCP provider.
 * Manages MCP servers in ~/.claude.json
 */
export class ClaudeProvider extends MCPProvider {
    constructor() {
        const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
        super(path.join(homeDir, ".claude.json"), "claude");
    }

    async configExists(): Promise<boolean> {
        return existsSync(this.configPath);
    }

    async readConfig(): Promise<ClaudeGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return JSON.parse(content) as ClaudeGenericConfig;
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

        // Global servers
        if (config.mcpServers) {
            const disabledServers = new Set(config.disabledMcpServers || []);
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                servers.push({
                    name,
                    config: this.claudeToUnified(serverConfig),
                    enabled: !disabledServers.has(name),
                    provider: this.providerName,
                });
            }
        }

        // Project-specific servers
        if (config.projects) {
            for (const [projectPath, projectConfig] of Object.entries(config.projects)) {
                if (projectConfig.mcpServers) {
                    const projectDisabled = new Set(projectConfig.disabledMcpServers || []);
                    for (const [name, serverConfig] of Object.entries(projectConfig.mcpServers)) {
                        // Only add if not already in global list
                        if (!servers.find((s) => s.name === name)) {
                            servers.push({
                                name,
                                config: this.claudeToUnified(serverConfig),
                                enabled: !projectDisabled.has(name),
                                provider: `${this.providerName}:${projectPath}`,
                            });
                        }
                    }
                }
            }
        }

        return servers;
    }

    async getServerConfig(serverName: string): Promise<UnifiedMCPServerConfig | null> {
        const config = await this.readConfig();

        // Check global servers first
        if (config.mcpServers?.[serverName]) {
            return this.claudeToUnified(config.mcpServers[serverName]);
        }

        // Check project-specific servers
        if (config.projects) {
            for (const projectConfig of Object.values(config.projects)) {
                if (projectConfig.mcpServers?.[serverName]) {
                    return this.claudeToUnified(projectConfig.mcpServers[serverName]);
                }
            }
        }

        return null;
    }

    async enableServer(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Remove from disabled list
        if (config.disabledMcpServers) {
            config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
        }

        // Also remove from project-specific disabled lists
        if (config.projects) {
            for (const projectConfig of Object.values(config.projects)) {
                if (projectConfig.disabledMcpServers) {
                    projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter(
                        (name) => name !== serverName
                    );
                }
            }
        }

        await this.writeConfig(config);
    }

    async disableServer(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Add to disabled list
        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }
        if (!config.disabledMcpServers.includes(serverName)) {
            config.disabledMcpServers.push(serverName);
        }

        await this.writeConfig(config);
    }

    async disableServerForAllProjects(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Disable globally
        await this.disableServer(serverName);

        // Also disable in all projects
        if (config.projects) {
            for (const projectConfig of Object.values(config.projects)) {
                if (!projectConfig.disabledMcpServers) {
                    projectConfig.disabledMcpServers = [];
                }
                if (!projectConfig.disabledMcpServers.includes(serverName)) {
                    projectConfig.disabledMcpServers.push(serverName);
                }
            }
        }

        await this.writeConfig(config);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void> {
        const claudeConfig = await this.readConfig();

        if (!claudeConfig.mcpServers) {
            claudeConfig.mcpServers = {};
        }

        claudeConfig.mcpServers[serverName] = this.unifiedToClaude(config);

        // Ensure it's enabled
        await this.enableServer(serverName);

        await this.writeConfig(claudeConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Add/update all servers
        for (const [name, serverConfig] of Object.entries(servers)) {
            config.mcpServers[name] = this.unifiedToClaude(serverConfig);
        }

        // Remove disabled servers from disabled list if they're enabled in unified config
        if (config.disabledMcpServers) {
            config.disabledMcpServers = config.disabledMcpServers.filter((name) => {
                const unified = servers[name];
                return unified && unified.disabled === true;
            });
        }

        await this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const claudeConfig = config as ClaudeGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (claudeConfig.mcpServers) {
            const disabledServers = new Set(claudeConfig.disabledMcpServers || []);
            for (const [name, serverConfig] of Object.entries(claudeConfig.mcpServers)) {
                result[name] = {
                    ...this.claudeToUnified(serverConfig),
                    enabled: !disabledServers.has(name),
                };
            }
        }

        return result;
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: ClaudeGenericConfig = {
            mcpServers: {},
            disabledMcpServers: [],
        };

        for (const [name, unified] of Object.entries(servers)) {
            config.mcpServers![name] = this.unifiedToClaude(unified);
            if (unified.disabled === true || unified.enabled === false) {
                config.disabledMcpServers!.push(name);
            }
        }

        return config;
    }

    private claudeToUnified(claude: ClaudeMCPServerConfig): UnifiedMCPServerConfig {
        return {
            type: (claude.type as "stdio" | "sse" | "http") || "stdio",
            command: claude.command,
            args: claude.args,
            env: claude.env,
            url: claude.url,
        };
    }

    private unifiedToClaude(unified: UnifiedMCPServerConfig): ClaudeMCPServerConfig {
        return {
            type: unified.type || "stdio",
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url,
        };
    }
}
