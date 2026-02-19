import logger from "@app/logger";
import { stripMeta } from "@app/mcp-manager/utils/config.utils.js";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeGenericConfig, ClaudeMCPServerConfig } from "./claude.types.js";
import type { MCPServerInfo, UnifiedMCPServerConfig } from "./types.js";
import { MCPProvider, WriteResult } from "./types.js";

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

    supportsDisabledState(): boolean {
        return true; // Claude has disabledMcpServers list
    }

    async readConfig(): Promise<ClaudeGenericConfig> {
        if (!(await this.configExists())) {
            return { mcpServers: {} };
        }

        const content = await readFile(this.configPath, "utf-8");
        return JSON.parse(content) as ClaudeGenericConfig;
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

    async getServerEnabledStatesPerProject(): Promise<Map<string, Record<string, boolean>>> {
        const config = await this.readConfig();
        const result = new Map<string, Record<string, boolean>>();

        // Get all global servers
        const globalServerNames = config.mcpServers ? Object.keys(config.mcpServers) : [];

        // Initialize map for all global servers
        for (const serverName of globalServerNames) {
            result.set(serverName, {});
        }

        // Process per-project disabledMcpServers
        if (config.projects) {
            for (const [projectPath, projectConfig] of Object.entries(config.projects)) {
                const projectDisabled = new Set(projectConfig.disabledMcpServers || []);

                // For each global server, check if it's disabled in this project
                for (const serverName of globalServerNames) {
                    const isDisabledInProject = projectDisabled.has(serverName);
                    const isEnabledInProject = !isDisabledInProject;

                    if (!result.has(serverName)) {
                        result.set(serverName, {});
                    }
                    result.get(serverName)![projectPath] = isEnabledInProject;
                }

                // Also check project-specific servers
                if (projectConfig.mcpServers) {
                    for (const serverName of Object.keys(projectConfig.mcpServers)) {
                        if (!result.has(serverName)) {
                            result.set(serverName, {});
                        }
                        const isDisabledInProject = projectDisabled.has(serverName);
                        const isEnabledInProject = !isDisabledInProject;
                        result.get(serverName)![projectPath] = isEnabledInProject;
                    }
                }
            }
        }

        return result;
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
                    ].disabledMcpServers?.filter((name) => name !== serverName);
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
                if (!config.projects[projectPath].disabledMcpServers?.includes(serverName)) {
                    config.projects[projectPath].disabledMcpServers?.push(serverName);
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

    async enableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        for (const serverName of serverNames) {
            if (projectPath === null) {
                if (config.disabledMcpServers) {
                    config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
                }
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
                if (config.projects?.[projectPath]?.disabledMcpServers) {
                    config.projects[projectPath].disabledMcpServers = config.projects[
                        projectPath
                    ].disabledMcpServers?.filter((name) => name !== serverName);
                }
            } else {
                if (config.disabledMcpServers) {
                    config.disabledMcpServers = config.disabledMcpServers.filter((name) => name !== serverName);
                }
            }
        }

        return this.writeConfig(config);
    }

    async disableServers(serverNames: string[], projectPath?: string | null): Promise<WriteResult> {
        const config = await this.readConfig();

        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }

        for (const serverName of serverNames) {
            if (projectPath === null) {
                if (!config.disabledMcpServers.includes(serverName)) {
                    config.disabledMcpServers.push(serverName);
                }
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
                if (config.projects?.[projectPath]) {
                    if (!config.projects[projectPath].disabledMcpServers) {
                        config.projects[projectPath].disabledMcpServers = [];
                    }
                    if (!config.projects[projectPath].disabledMcpServers?.includes(serverName)) {
                        config.projects[projectPath].disabledMcpServers?.push(serverName);
                    }
                }
            } else {
                if (!config.disabledMcpServers.includes(serverName)) {
                    config.disabledMcpServers.push(serverName);
                }
            }
        }

        return this.writeConfig(config);
    }

    async installServer(serverName: string, config: UnifiedMCPServerConfig): Promise<WriteResult> {
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

        return this.writeConfig(claudeConfig);
    }

    async syncServers(servers: Record<string, UnifiedMCPServerConfig>): Promise<WriteResult> {
        const config = await this.readConfig();

        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        if (!config.disabledMcpServers) {
            config.disabledMcpServers = [];
        }

        for (const [name, serverConfig] of Object.entries(servers)) {
            const cleanConfig = stripMeta(serverConfig);
            config.mcpServers[name] = this.unifiedToClaude(cleanConfig);

            const enabledState = serverConfig._meta?.enabled?.claude;
            const isGloballyEnabled = typeof enabledState === "boolean" && enabledState === true;

            if (isGloballyEnabled) {
                config.disabledMcpServers = config.disabledMcpServers.filter((n) => n !== name);
            } else if (!config.disabledMcpServers.includes(name)) {
                config.disabledMcpServers.push(name);
            }

            if (config.projects) {
                for (const [projectPath, projectConfig] of Object.entries(config.projects)) {
                    if (!projectConfig.disabledMcpServers) {
                        projectConfig.disabledMcpServers = [];
                    }

                    const isEnabledForProject = this.isServerEnabledInMeta(serverConfig, projectPath);

                    if (isEnabledForProject) {
                        projectConfig.disabledMcpServers = projectConfig.disabledMcpServers.filter((n) => n !== name);
                        if (projectConfig.mcpServers?.[name]) {
                            projectConfig.mcpServers[name] = this.unifiedToClaude(cleanConfig);
                        }
                    } else {
                        if (!projectConfig.disabledMcpServers.includes(name)) {
                            projectConfig.disabledMcpServers.push(name);
                        }
                        if (projectConfig.mcpServers?.[name]) {
                            delete projectConfig.mcpServers[name];
                        }
                    }
                }
            }
        }

        return this.writeConfig(config);
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
            // Read enabled state using utility method (checks global enablement)
            const isEnabled = this.isServerEnabledInMeta(unified);

            // Strip _meta before converting
            const cleanConfig = stripMeta(unified);
            config.mcpServers![name] = this.unifiedToClaude(cleanConfig);

            if (!isEnabled) {
                config.disabledMcpServers?.push(name);
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
            headers: (claude as any).headers,
        };
    }

    private unifiedToClaude(unified: UnifiedMCPServerConfig): ClaudeMCPServerConfig {
        return {
            type: unified.type || "stdio",
            command: unified.command,
            args: unified.args,
            env: unified.env,
            url: unified.url,
            ...(unified.headers && { headers: unified.headers }),
        } as ClaudeMCPServerConfig;
    }
}
