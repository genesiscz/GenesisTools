import { MCPProvider } from "./types.js";
import type { UnifiedMCPServerConfig, MCPServerInfo } from "./types.js";
import type { ClaudeMCPServerConfig, ClaudeGenericConfig } from "./claude.types.js";
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import logger from "@app/logger";
import chalk from "chalk";
import { stripMeta } from "../config.utils.js";

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

    async getProjects(): Promise<string[]> {
        const config = await this.readConfig();
        if (!config.projects) {
            return [];
        }
        return Object.keys(config.projects);
    }

    async enableServer(serverName: string, projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        if (projectPath === null) {
            // Enable globally (all projects)
            if (config.disabledMcpServers) {
                config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
            }

            // Also remove from all project-specific disabled lists
            if (config.projects) {
                for (const projectConfig of Object.values(config.projects)) {
                    if (projectConfig.disabledMcpServers) {
                        projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter(
                            (name) => name !== serverName
                        );
                    }
                }
            }
        } else if (projectPath !== undefined) {
            // Enable for specific project
            if (config.projects?.[projectPath]) {
                if (config.projects[projectPath].disabledMcpServers) {
                    config.projects[projectPath].disabledMcpServers = config.projects[
                        projectPath
                    ].disabledMcpServers!.filter((name) => name !== serverName);
                }
            }
        } else {
            // No project specified - enable globally only
            if (config.disabledMcpServers) {
                config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
            }
        }

        await this.writeConfig(config);
    }

    async disableServer(serverName: string, projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        if (projectPath === null) {
            // Disable globally (all projects)
            if (!config.disabledMcpServers) {
                config.disabledMcpServers = [];
            }
            if (!config.disabledMcpServers.includes(serverName)) {
                config.disabledMcpServers.push(serverName);
            }

            // Also disable in all project-specific lists
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
        } else if (projectPath !== undefined) {
            // Disable for specific project
            if (config.projects?.[projectPath]) {
                if (!config.projects[projectPath].disabledMcpServers) {
                    config.projects[projectPath].disabledMcpServers = [];
                }
                if (!config.projects[projectPath].disabledMcpServers!.includes(serverName)) {
                    config.projects[projectPath].disabledMcpServers!.push(serverName);
                }
            }
        } else {
            // No project specified - disable globally only
            if (!config.disabledMcpServers) {
                config.disabledMcpServers = [];
            }
            if (!config.disabledMcpServers.includes(serverName)) {
                config.disabledMcpServers.push(serverName);
            }
        }

        await this.writeConfig(config);
    }

    async enableServerForAllProjects(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Enable globally
        if (config.disabledMcpServers) {
            config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
        }

        // Also enable in all projects
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

    async disableServerForAllProjects(serverName: string): Promise<void> {
        const config = await this.readConfig();

        // Disable globally
        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }
        if (!config.disabledMcpServers.includes(serverName)) {
            config.disabledMcpServers.push(serverName);
        }

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

    async enableServers(serverNames: string[], projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        for (const serverName of serverNames) {
            if (projectPath === null) {
                // Enable globally (all projects)
                if (config.disabledMcpServers) {
                    config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
                }
                // Also remove from all project-specific disabled lists
                if (config.projects) {
                    for (const projectConfig of Object.values(config.projects)) {
                        if (projectConfig.disabledMcpServers) {
                            projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter(
                                (name) => name !== serverName
                            );
                        }
                    }
                }
            } else if (projectPath !== undefined) {
                // Enable for specific project
                if (config.projects?.[projectPath]?.disabledMcpServers) {
                    config.projects[projectPath].disabledMcpServers = config.projects[
                        projectPath
                    ].disabledMcpServers!.filter((name) => name !== serverName);
                }
            } else {
                // No project specified - enable globally only
                if (config.disabledMcpServers) {
                    config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
                }
            }
        }

        await this.writeConfig(config);
    }

    async disableServers(serverNames: string[], projectPath?: string | null): Promise<void> {
        const config = await this.readConfig();

        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }

        for (const serverName of serverNames) {
            if (projectPath === null) {
                // Disable globally (all projects)
                if (!config.disabledMcpServers.includes(serverName)) {
                    config.disabledMcpServers.push(serverName);
                }
                // Also disable in all project-specific lists
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
            } else if (projectPath !== undefined) {
                // Disable for specific project
                if (config.projects?.[projectPath]) {
                    if (!config.projects[projectPath].disabledMcpServers) {
                        config.projects[projectPath].disabledMcpServers = [];
                    }
                    if (!config.projects[projectPath].disabledMcpServers!.includes(serverName)) {
                        config.projects[projectPath].disabledMcpServers!.push(serverName);
                    }
                }
            } else {
                // No project specified - disable globally only
                if (!config.disabledMcpServers.includes(serverName)) {
                    config.disabledMcpServers.push(serverName);
                }
            }
        }

        await this.writeConfig(config);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<void> {
        // Strip _meta before processing (unified utility ensures _meta never reaches providers)
        const cleanConfig = stripMeta(config);
        const claudeConfig = await this.readConfig();

        if (!claudeConfig.mcpServers) {
            claudeConfig.mcpServers = {};
        }

        claudeConfig.mcpServers[serverName] = this.unifiedToClaude(cleanConfig);

        // Ensure it's enabled by removing from disabled list (modify same config object)
        if (claudeConfig.disabledMcpServers) {
            claudeConfig.disabledMcpServers = claudeConfig.disabledMcpServers.filter((name) => name !== serverName);
        }

        // Also remove from project-specific disabled lists
        if (claudeConfig.projects) {
            for (const projectConfig of Object.values(claudeConfig.projects)) {
                if (projectConfig.disabledMcpServers) {
                    projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter(
                        (name) => name !== serverName
                    );
                }
            }
        }

        await this.writeConfig(claudeConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<void> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }

        // Add/update all servers
        for (const [name, serverConfig] of Object.entries(servers)) {
            // Read enabled state from _meta.enabled[providerName]
            const isEnabled = serverConfig._meta?.enabled?.claude !== false; // default to enabled if not specified

            // Strip _meta before writing to provider config
            const cleanConfig = stripMeta(serverConfig);
            config.mcpServers[name] = this.unifiedToClaude(cleanConfig);

            // Update disabledMcpServers based on _meta.enabled.claude
            if (isEnabled) {
                config.disabledMcpServers = config.disabledMcpServers.filter((n) => n !== name);
            } else if (!config.disabledMcpServers.includes(name)) {
                config.disabledMcpServers.push(name);
            }
        }

        await this.writeConfig(config);
    }

    toUnifiedConfig(config: unknown): Record<string, UnifiedMCPServerConfig> {
        const claudeConfig = config as ClaudeGenericConfig;
        const result: Record<string, UnifiedMCPServerConfig> = {};

        if (claudeConfig.mcpServers) {
            for (const [name, serverConfig] of Object.entries(claudeConfig.mcpServers)) {
                // Strip _meta if it somehow got into provider config (shouldn't happen, but safety check)
                result[name] = stripMeta(this.claudeToUnified(serverConfig));
            }
        }

        return result;
    }

    /**
     * Check if a server is enabled in this provider's config
     */
    async isServerEnabled(serverName: string): Promise<boolean> {
        const config = await this.readConfig();
        const disabledServers = new Set(config.disabledMcpServers || []);
        return !disabledServers.has(serverName);
    }

    fromUnifiedConfig(servers: Record<string, UnifiedMCPServerConfig>): unknown {
        const config: ClaudeGenericConfig = {
            mcpServers: {},
            disabledMcpServers: [],
        };

        for (const [name, unified] of Object.entries(servers)) {
            // Read enabled state from _meta.enabled[providerName]
            const isEnabled = unified._meta?.enabled?.claude !== false;

            // Strip _meta before converting
            const cleanConfig = stripMeta(unified);
            config.mcpServers![name] = this.unifiedToClaude(cleanConfig);

            if (!isEnabled) {
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
